import cron from "node-cron";
import express from "express";
import axios from "axios";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import sequelize from "#configs/database";
// Provide a resolver that returns the Angel option object you showed
// Example signature: resolveAngelOption(baseName, strike, direction) -> { token, symbol, name, expiry, strike, lotsize, instrumenttype, exch_seg, tick_size }
import { resolveAngelOption } from "#utils/angelInstruments";
import BrokerKey from "#models/brokerKey";
import Broker from "#models/broker";
import TradeLog from "#models/tradeLog";
import { logInfo, logWarn, logError } from "./utils/logger.js";

// SmartAPI notes:
// - Auth: Bearer token per key (key.token) for SmartAPI REST.
// - Place Order endpoint params commonly include: variety, tradingsymbol, symboltoken, transactiontype, exchange, ordertype, producttype, duration, price, quantity.
// - LTP/Quote: POST to quote endpoint with exchange and token; or use SmartAPI SDK. Here we use REST with minimal JSON per Angel docs.

// Bootstrap
try {
  await sequelize.authenticate();
  logInfo("Database connected", {
    dialect: sequelize.getDialect && sequelize.getDialect(),
  });
} catch (e) {
  logError("AngelOne runner cannot connect DB", e);
  process.exit(1);
}

const server = express();

let dailyAsset = null;
let keys = null;
let adminKeys = null;
let dailyLevels = null;

const dayMap = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

// Helper: Kite-compatible IST timestamp: "YYYY-MM-DD HH:mm:00"
function toKiteISTFormat(dateObj) {
  const local = new Date(
    dateObj.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  const hh = String(local.getHours()).padStart(2, "0");
  const min = String(local.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

// EXP: market hours gates
function computeGates(nowIST) {
  const h = nowIST.getHours();
  const m = nowIST.getMinutes();
  const s = nowIST.getSeconds();
  const preRange =
    (h === 8 && m >= 30) || (h > 8 && h < 15) || (h === 15 && m <= 30);
  const isInMarketRange =
    (h === 9 && m >= 30) || (h > 9 && h < 15) || (h === 15 && m <= 15);
  return { preRange, isInMarketRange, h, m, s };
}

// Exit open trades for Angel One
async function exitOpenTrades(targetKeys) {
  for (const key of targetKeys) {
    const placeOrder = async ({
      tradingsymbol,
      symboltoken,
      transactiontype = "BUY", // BUY/SELL
      quantity = 1,
      exchange = "NFO", // For options: NFO
      producttype = "INTRADAY", // I.e., "INTRADAY"
      ordertype = "MARKET",
      variety = "NORMAL",
      duration = "DAY",
      price = 0,
      accessToken = key.token,
    }) => {
      try {
        const orderparams = {
          variety,
          tradingsymbol, // e.g., "NIFTY09SEP2524000CE"
          symboltoken, // e.g., "40536"
          transactiontype, // "BUY" | "SELL"
          exchange, // e.g., "NFO"
          ordertype, // "MARKET"
          producttype, // "INTRADAY"
          duration, // "DAY"
          price: String(price),
          quantity: String(quantity),
          triggerprice: "0",
        };

        const response = await axios.post(
          "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
          orderparams,
          {
            headers: {
              "X-PrivateKey": key.apiKey, // SmartAPI API Key
              Authorization: `Bearer ${accessToken}`, // Access token per user session
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          },
        );
        logInfo("Angel Order placed (exitOpenTrades)", {
          brokerKeyId: key.id,
          side: transactiontype,
          qty: quantity,
          tradingsymbol,
          token: symboltoken,
          order_id:
            response?.data?.data?.orderid || response?.data?.data?.orderId,
        });
        return response.data;
      } catch (err) {
        logError("Angel Order placement failed (exitOpenTrades)", err, {
          brokerKeyId: key.id,
          side: transactiontype,
          tradingsymbol,
          token: symboltoken,
          qty: quantity,
        });
        // continue flow; still try to deactivate
      }
    };

    const newOrder = async (data) => {
      data.transactiontype = "BUY";
      return await placeOrder(data);
    };
    const exitOrder = async (data) => {
      data.transactiontype = "SELL";
      return await placeOrder(data);
    };

    try {
      const lastTrade = await TradeLog.findDoc(
        { brokerKeyId: key.id, type: "entry" },
        { allowNull: true },
      );
      if (!lastTrade) {
        if (!key.status) continue;
        key.status = false;
        await key.save();
        logInfo("No last trade; marking key inactive (Angel close)", {
          brokerKeyId: key.id,
        });
        continue;
      }

      // lastTrade.asset stored for Angel should be the token or compound "NFO|token"
      // In this project, for other brokers asset stores the symbol string, so store Angel as "<exch_seg>|<token>|<tradingsymbol>" for clarity.
      // If existing data is only token or tradingsymbol, adjust split logic gracefully:
      const parts = String(lastTrade.asset).split("|");
      const symboltoken = parts[14] || parts;
      const tradingsymbol = parts[10] || parts;

      const exitOrderData = {
        tradingsymbol,
        symboltoken,
        quantity: lastTrade.quantity,
        exchange: "NFO",
      };

      logInfo("Exiting last Angel trade (close)", {
        brokerKeyId: key.id,
        asset: lastTrade.asset,
        qty: lastTrade.quantity,
      });
      await exitOrder(exitOrderData);
      lastTrade.type = "exit";
      await lastTrade.save();
      key.status = false;
      await key.save();
      logInfo("Angel key inactive after closing trade", {
        brokerKeyId: key.id,
      });
    } catch (e) {
      logError("exitOpenTrades (Angel) failed", e, { brokerKeyId: key?.id });
    }
  }
}

// Flags for two crons
let isRunning3Min = false;
let isRunning5Min = false;

// Shared trading logic for Angel
async function runTradingLogic({ intervalMinutes, intervalString }) {
  const istNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const {
    preRange,
    isInMarketRange,
    h: istHour,
    m: istMinute,
    s: second,
  } = computeGates(istNow);

  if (!preRange && !isInMarketRange) return;

  if (preRange) {
    if (!dailyLevels) {
      const [dailyData] = await sequelize.query(
        `SELECT * FROM "DailyLevels" WHERE "forDay" = '${getISTMidnightFakeUTCString()}'`,
      );
      dailyLevels = Array.isArray(dailyData) ? dailyData : dailyData;
      logInfo("Angel loaded dailyLevels", { present: !!dailyLevels });
    }
    if (!dailyAsset) {
      const day = dayMap[istNow.getDay()];
      const [response] = await sequelize.query(
        `SELECT "name", "zerodhaToken","Assets"."id" FROM "DailyAssets"
         INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
         WHERE "day" = '${day}'`,
      );
      if (!response.length) {
        logWarn("❌ No asset available for today (Angel)", { day });
        return;
      }
      dailyAsset = response;
      logInfo("Angel loaded dailyAsset", {
        name: dailyAsset?.name,
        token: dailyAsset?.zerodhaToken,
      });
    }
    if (!keys || !adminKeys || (istMinute % 1 === 0 && second % 40 === 0)) {
      const responseKeys = await BrokerKey.findAll({
        include: [{ model: Broker, where: { name: "Angel One" } }],
        where: { status: true },
      });
      // Admin key: using Zerodha admin query earlier wouldn't apply; for Angel we don't need admin for historical,
      // but keep adminKeys slot for future (e.g., central config). Load first Angel admin key if exists:
      const [admin] = await sequelize.query(
        `SELECT * FROM "BrokerKeys"
         INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
         INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
         WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Angel One'`,
      );
      adminKeys = Array.isArray(admin) ? admin : admin; // may be null; not strictly required below
      keys = responseKeys;
      logInfo("Angel refreshed keys/adminKeys", {
        keysCount: Array.isArray(keys) ? keys.length : 0,
        hasAdmin: !!adminKeys,
      });
    }
  }

  // Hard exit time 15:15 IST
  if (istHour === 15 && istMinute === 15) {
    logInfo("Angel hard exit time — exiting open trades");
    return await exitOpenTrades(keys || []);
  }

  // Historical candles come from Kite in existing pipeline; we keep that, then place via Angel.
  if (isInMarketRange && second % 10 === 0) {
    const toTime = toKiteISTFormat(istNow);
    const fromTime = toKiteISTFormat(
      new Date(istNow.getTime() - intervalMinutes * 60 * 1000),
    );
    const instrumentToken = dailyAsset.zerodhaToken; // still using existing asset source for candles
    const interval = intervalString;

    // Use Zerodha public API for candles as in other scripts
    const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(
      fromTime,
    )}&to=${encodeURIComponent(toTime)}&continuous=false`;

    let dataObj;
    try {
      // For Kite historical we require apiKey/accessToken; reuse an admin Zerodha key or your existing admin if available.
      // If not available here, consider persisting a system Zerodha admin for candles. For now, try load one-off admin for Zerodha:
      let zAdmin = null;
      if (!adminKeys || adminKeys?.brokerIdName !== "Zerodha") {
        const [z] = await sequelize.query(
          `SELECT "BrokerKeys".*, "Brokers"."name" as "brokerIdName" FROM "BrokerKeys"
           INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
           INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
           WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Zerodha'
           LIMIT 1`,
        );
        zAdmin = Array.isArray(z) ? z : z;
      } else {
        zAdmin = adminKeys;
      }
      if (!zAdmin?.apiKey || !zAdmin?.token) {
        logWarn("Angel runner lacks Zerodha admin for candles; skip tick", {});
        return;
      }

      const response = await axios.get(url, {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${zAdmin.apiKey}:${zAdmin.token}`,
        },
      });
      dataObj = response?.data?.data;
    } catch (e) {
      logError("Angel historical fetch (via Kite) failed", e, {
        instrumentToken,
        interval,
        fromTime,
        toTime,
      });
      return;
    }

    if (
      !dataObj ||
      !Array.isArray(dataObj.candles) ||
      dataObj.candles.length === 0
    ) {
      logWarn("⚠️ No candle data available (Angel via Kite)", {
        instrumentToken,
        interval,
        fromTime,
        toTime,
      });
      return;
    }

    const latestCandle = dataObj.candles[dataObj.candles.length - 1];
    // Kite candles: [time, open, high, low, close, volume]
    const price = latestCandle?.[15];
    if (price == null) {
      logWarn("⚠️ Invalid Price (Angel)", { latestCandle });
      return;
    }

    const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4 } = dailyLevels;
    const BUFFER = dailyLevels.buffer;

    let signal = "No Action";
    let reason = "Neutral";
    let direction;
    let assetPrice;

    // Round to 100 as in other runners
    assetPrice =
      price % 100 > 50
        ? Math.trunc(price / 100) * 100 + 100
        : Math.trunc(price / 100) * 100;

    if (price >= tc && price <= tc + BUFFER) {
      direction = "CE";
      signal = "Buy";
      reason = "Above TC within buffer";
    } else if (price <= bc && price >= bc - BUFFER) {
      direction = "PE";
      signal = "Sell";
      reason = "Below BC within buffer";
    } else if (price < tc && price > bc) {
      signal = "Exit";
      reason = "Inside CPR";
    }

    const levelsMap = { r1, r2, r3, r4, s1, s2, s3, s4 };
    Object.entries(levelsMap).forEach(([levelName, level]) => {
      if (price > level && price <= level + BUFFER) {
        signal = "Buy";
        reason = `Above ${levelName} within buffer`;
        direction = "CE";
      } else if (price < level && price >= level - BUFFER) {
        signal = "Sell";
        reason = `Below ${levelName} within buffer`;
        direction = "PE";
      }
    });

    const innerLevelMap = { r1, r2, r3, r4, s1, s2, s3, s4, tc, bc };
    const o = latestCandle?.[14];
    const c = latestCandle?.[15];
    Object.entries(innerLevelMap).find(([levelName, level]) => {
      if (signal === "No Action") {
        if (c > level && o < level) {
          signal = "PE Exit";
          reason = `Crossed ${levelName}`;
          return true;
        }
        if (c < level && o > level) {
          signal = "CE Exit";
          reason = `Crossed ${levelName}`;
          return true;
        }
      }
      return false;
    });

    if (direction === "CE") assetPrice += intervalMinutes === 3 ? 600 : 400;
    else if (direction === "PE")
      assetPrice -= intervalMinutes === 3 ? 600 : 400;

    // Resolve Angel option contract using provided resolver shape
    let angelOption; // { token, symbol, name, expiry, strike, lotsize, instrumenttype, exch_seg, tick_size }
    if (direction) {
      try {
        angelOption = await resolveAngelOption(
          dailyAsset.name,
          assetPrice,
          direction,
        );
      } catch (e) {
        logError("resolveAngelOption failed (Angel)", e, {
          base: dailyAsset?.name,
          assetPrice,
          direction,
          tf: intervalString,
        });
      }
    }

    logInfo("Angel signal snapshot", {
      t: istNow.toISOString(),
      price,
      direction,
      signal,
      reason,
      tf: intervalString,
      resolved: angelOption?.symbol,
    });

    // Trade loop per key
    for (const key of keys || []) {
      try {
        // Strict minute/second guards for 3m/5m
        if (intervalMinutes === 3) {
          if (second >= 10) continue;
          if (istMinute % 3 !== 0) continue;
        } else if (intervalMinutes === 5) {
          if (second !== 0) continue;
          if (istMinute % 5 !== 0) continue;
        }

        // Angel LTP via Quote API (LTP mode)
        const getLTP = async (exch_seg, token, accessToken = key.token) => {
          try {
            const body = {
              mode: "LTP",
              exchangeTokens: {
                [exch_seg]: [String(token)],
              },
            };
            const res = await axios.post(
              "https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/",
              body,
              {
                headers: {
                  "X-PrivateKey": key.apiKey,
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
              },
            );
            // Response shape: data[fqnKey]?.ltp etc. We handle both arrays and maps as per docs evolution.
            const data = res?.data?.data;
            // Try to find first value with ltp
            if (Array.isArray(data) && data.length) {
              return data?.ltp || data?.last_traded_price || data?.Ltp;
            } else if (data && typeof data === "object") {
              const first = Object.values(data);
              return first?.ltp || first?.last_traded_price || first?.Ltp;
            }
            return undefined;
          } catch (err) {
            logError("Angel LTP fetch failed", err, {
              exch_seg,
              token,
              brokerKeyId: key.id,
            });
            throw err;
          }
        };

        const getTodaysPnL = async (accessToken = key.token) => {
          try {
            // Angel positions endpoint
            const res = await axios.get(
              "https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getPosition",
              {
                headers: {
                  "X-PrivateKey": key.apiKey,
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                },
              },
            );
            const positions = res?.data?.data || [];
            // Sum P&L across intraday positions; fields may vary across segments. Use netPnL if present or (pnl/mtm)
            let total = 0;
            for (const p of positions) {
              if (
                p?.producttype === "INTRADAY" ||
                p?.productType === "INTRADAY"
              ) {
                const x =
                  Number(p?.realised || p?.realized || 0) +
                  Number(p?.unrealised || p?.unrealized || p?.mtm || 0);
                total += x;
              }
            }
            return total;
          } catch (e) {
            logError("Angel fetch today's PnL failed", e, {
              brokerKeyId: key.id,
            });
            throw e;
          }
        };

        // Capital usage: Angel keys may not expose opening balance via API easily; if not available,
        // store balance on key record, or set a default. Here, reuse key.balance if available, else fallback to a conservative default.
        const balance = Number(key.balance || 100000); // fallback 1L if not stored
        const usableFunds = (balance / 100) * 10;

        let ltp;
        let noOfLots;
        if (direction && angelOption?.token && angelOption?.lotsize) {
          ltp = await getLTP(angelOption.exch_seg || "NFO", angelOption.token);
          if (!ltp || !angelOption.lotsize) {
            logWarn("Angel missing LTP or lotsize; skip sizing", {
              symbol: angelOption?.symbol,
              token: angelOption?.token,
            });
          } else {
            noOfLots = Math.floor(usableFunds / (ltp * angelOption.lotsize));
          }
        }

        const pnl = await getTodaysPnL();
        const maxLoss = (balance / 100) * 4;
        const maxProfit = (balance / 100) * 8;

        const placeOrder = async ({
          tradingsymbol,
          symboltoken,
          transactiontype = "BUY",
          quantity = 1,
          exchange = "NFO",
          producttype = "INTRADAY",
          ordertype = "MARKET",
          variety = "NORMAL",
          duration = "DAY",
          price = 0,
          accessToken = key.token,
        }) => {
          try {
            const orderparams = {
              variety,
              tradingsymbol,
              symboltoken,
              transactiontype,
              exchange,
              ordertype,
              producttype,
              duration,
              price: String(price),
              quantity: String(quantity),
              triggerprice: "0",
            };
            const response = await axios.post(
              "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
              orderparams,
              {
                headers: {
                  "X-PrivateKey": key.apiKey,
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
              },
            );
            logInfo("Angel Order placed", {
              tf: intervalString,
              brokerKeyId: key.id,
              tradingsymbol,
              token: symboltoken,
              side: transactiontype,
              qty: quantity,
              order_id:
                response?.data?.data?.orderid || response?.data?.data?.orderId,
            });
            return response.data;
          } catch (err) {
            logError("Angel Order placement failed", err, {
              tf: intervalString,
              brokerKeyId: key.id,
              tradingsymbol,
              token: symboltoken,
              side: transactiontype,
              qty: quantity,
            });
            throw err;
          }
        };

        const newOrder = async (data) => {
          data.transactiontype = "BUY";
          return await placeOrder(data);
        };
        const exitOrder = async (data) => {
          data.transactiontype = "SELL";
          return await placeOrder(data);
        };

        const lastTrade = await TradeLog.findDoc(
          { brokerKeyId: key.id, type: "entry" },
          { allowNull: true },
        );

        // Daily guard
        if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
          if (!lastTrade) {
            key.status = false;
            await key.save();
            logInfo("Angel deactivated due to daily limit (no open trade)", {
              tf: intervalString,
              brokerKeyId: key.id,
              pnl,
              balance,
            });
            continue;
          }
          // Parse stored asset: "<exch_seg>|<token>|<tradingsymbol>" or raw tradingsymbol
          const parts = String(lastTrade.asset).split("|");
          const symboltoken = parts[14] || parts;
          const tradingsymbol = parts[10] || parts;
          const exitOrderData = {
            tradingsymbol,
            symboltoken,
            quantity: lastTrade.quantity,
            exchange: "NFO",
          };
          logInfo("Angel exiting last trade (daily limit)", {
            tf: intervalString,
            brokerKeyId: key.id,
            pnl,
            balance,
          });
          await exitOrder(exitOrderData);
          lastTrade.type = "exit";
          await lastTrade.save();
          key.status = false;
          await key.save();
          logInfo("Angel deactivated after exit (daily limit)", {
            tf: intervalString,
            brokerKeyId: key.id,
          });
          continue;
        }

        if (signal === "No Action") continue;

        // Exit logic
        if (signal === "Exit" || signal === "PE Exit" || signal === "CE Exit") {
          if (!lastTrade) continue;
          const parts = String(lastTrade.asset).split("|");
          const symboltoken = parts[14] || parts;
          const tradingsymbol = parts[10] || parts;
          const exitOrderData = {
            tradingsymbol,
            symboltoken,
            quantity: lastTrade.quantity,
            exchange: "NFO",
          };
          if (signal === "PE Exit" && lastTrade.direction === "PE") {
            logInfo("Angel PE Exit matched; exiting", {
              tf: intervalString,
              brokerKeyId: key.id,
            });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          } else if (signal === "CE Exit" && lastTrade.direction === "CE") {
            logInfo("Angel CE Exit matched; exiting", {
              tf: intervalString,
              brokerKeyId: key.id,
            });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          }
          if (signal === "Exit") {
            logInfo("Angel generic Exit; closing last trade", {
              tf: intervalString,
              brokerKeyId: key.id,
            });
            await exitOrder(exitOrderData);
            lastTrade.type = "exit";
            await lastTrade.save();
            continue;
          }
        }

        // Entry or reversal
        if (!angelOption?.token || !angelOption?.symbol) continue;
        if (!noOfLots || noOfLots <= 0) continue;

        const newOrderData = {
          tradingsymbol: angelOption.symbol, // e.g., NIFTY09SEP2524000CE
          symboltoken: String(angelOption.token), // "40536"
          quantity: noOfLots * angelOption.lotsize,
          exchange: angelOption.exch_seg || "NFO",
        };

        if (lastTrade) {
          if (lastTrade.direction === direction) continue;

          const parts = String(lastTrade.asset).split("|");
          const symboltoken = parts[14] || parts;
          const tradingsymbol = parts[10] || parts;
          const exitOrderData = {
            tradingsymbol,
            symboltoken,
            quantity: lastTrade.quantity,
            exchange: "NFO",
          };

          logInfo("Angel direction changed; exiting last", {
            tf: intervalString,
            brokerKeyId: key.id,
            from: lastTrade.direction,
            to: direction,
          });
          await exitOrder(exitOrderData);
          lastTrade.type = "exit";
          await lastTrade.save();

          const newTradeLog = {
            brokerId: key.brokerId,
            brokerKeyId: key.id,
            userId: key.userId,
            baseAssetId: dailyAsset.id,
            asset: `${angelOption.exch_seg || "NFO"}|${angelOption.token}|${angelOption.symbol}`,
            direction,
            quantity: newOrderData.quantity,
            type: "entry",
          };
          logInfo("Angel placing new trade after exit", {
            tf: intervalString,
            brokerKeyId: key.id,
            symbol: newTradeLog.asset,
          });
          await placeOrder({ ...newOrderData, transactiontype: "BUY" });
          await TradeLog.create(newTradeLog);
        } else {
          const newTradeLog = {
            brokerId: key.brokerId,
            brokerKeyId: key.id,
            userId: key.userId,
            baseAssetId: dailyAsset.id,
            asset: `${angelOption.exch_seg || "NFO"}|${angelOption.token}|${angelOption.symbol}`,
            direction,
            quantity: newOrderData.quantity,
            type: "entry",
          };
          logInfo("Angel placing fresh trade", {
            tf: intervalString,
            brokerKeyId: key.id,
            symbol: newTradeLog.asset,
          });
          await placeOrder({ ...newOrderData, transactiontype: "BUY" });
          await TradeLog.create(newTradeLog);
        }
      } catch (e) {
        logError("Angel per-key execution failed", e, {
          tf: intervalString,
          brokerKeyId: key?.id,
        });
      }
    }
  }
}

// Schedules (small-cron)
cron.schedule("* * * * * *", async () => {
  if (isRunning3Min) return;
  isRunning3Min = true;
  try {
    await runTradingLogic({ intervalMinutes: 3, intervalString: "3minute" });
  } catch (e) {
    logError("Angel 3m cron failure", e);
  } finally {
    isRunning3Min = false;
  }
});

cron.schedule("* * * * * *", async () => {
  if (isRunning5Min) return;
  isRunning5Min = true;
  try {
    await runTradingLogic({ intervalMinutes: 5, intervalString: "5minute" });
  } catch (e) {
    logError("Angel 5m cron failure", e);
  } finally {
    isRunning5Min = false;
  }
});

// Stop endpoint — exits open Angel trades and deactivates
server.post("/stop/:id?", async (req, res) => {
  try {
    const { id } = req.params;
    let targetKeys;
    targetKeys = id
      ? await BrokerKey.findDocById(id)
      : await BrokerKey.findAll({
          include: [{ model: Broker, where: { name: "Angel One" } }],
          where: { status: true },
        });
    const arr = Array.isArray(targetKeys)
      ? targetKeys
      : [targetKeys].filter(Boolean);
    if (arr.length) {
      await exitOpenTrades(arr);
      logInfo("Angel deactivated via /stop", {
        count: arr.length,
        ids: arr.map((k) => k.id),
      });
    }
    res.status(200).json({ status: true, message: "Deactivated for the day" });
  } catch (e) {
    logError("Angel /stop failed", e);
    res.status(500).json({ status: false, message: "Internal Server error" });
  }
});

server.listen(3004, () => {
  logInfo("AngelOne runner listening", { port: 3004 });
});
