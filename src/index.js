// angelone.js
import cron from "node-cron";
import express from "express";
import axios from "axios";
import sequelize from "#configs/database";
import { getISTMidnightFakeUTCString } from "#utils/dayChecker";
import BrokerKey from "#models/brokerKey";
import Broker from "#models/broker";
import TradeLog from "#models/tradeLog";

// Reuse your Zerodha helper for historical candles and rounding/levels logic
import {
  main as kiteMain,
  getSpecificCachedOption as UNUSED,
} from "#utils/assetChecker"; // keeps parity with your runners
import {
  loadAngelScripMaster,
  resolveAngelOption,
  angelQuotePayloadFromResolved,
} from "./angelInstruments.util.js";

// TODO: Set these headers based on your environment
const X_HEADERS_BASE = {
  "X-UserType": "USER",
  "X-SourceID": "WEB",
  "X-ClientLocalIP": "127.0.0.1",
  "X-ClientPublicIP": "127.0.0.1",
  "X-MACAddress": "AA-BB-CC-DD-EE-FF",
  // "X-PrivateKey": "API_KEY" // set per key if needed
};

(async () => {
  try {
    await sequelize.authenticate();
    console.log("connected");
  } catch (e) {
    console.log("Cannot connect");
    process.exit(1);
  }

  await kiteMain(); // your existing loader for Zerodha instruments
  await loadAngelScripMaster(); // load Angel scrip master

  const server = express();

  let dailyAsset = null;
  let keys = null;
  let adminKeys = null;
  let dailyLevels = null;
  let isRunning = false;

  const dayMap = {
    1: "Monday",
    2: "Tuesday",
    3: "Wednesday",
    4: "Thursday",
    5: "Friday",
  };

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

  // Angel API helpers
  function angelHeaders(accessToken, apiKey) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...X_HEADERS_BASE,
      ...(apiKey ? { "X-PrivateKey": apiKey } : {}),
    };
  }

  async function angelGetFunds(accessToken, apiKey) {
    const url =
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS";
    const res = await axios.get(url, {
      headers: angelHeaders(accessToken, apiKey),
    });
    return Number(res.data?.data?.availablecash || 0);
  }

  async function angelGetPositions(accessToken, apiKey) {
    const url =
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getpositions";
    const res = await axios.get(url, {
      headers: angelHeaders(accessToken, apiKey),
    });
    return Array.isArray(res.data?.data) ? res.data.data : [];
  }

  async function angelGetTodaysPnL(accessToken, apiKey) {
    const positions = await angelGetPositions(accessToken, apiKey);
    let realised = 0,
      unrealised = 0;
    for (const p of positions) {
      realised += Number(p.realised || 0);
      unrealised += Number(p.unrealised || 0);
    }
    return realised + unrealised;
  }

  async function angelGetLTP(resolved, accessToken, apiKey) {
    const url =
      "https://apiconnect.angelone.in/order-service/rest/secure/angelbroking/order/v1/getLtpData";
    const payload = angelQuotePayloadFromResolved(resolved);
    const res = await axios.post(url, payload, {
      headers: angelHeaders(accessToken, apiKey),
    });
    const ltp = Number(res.data?.data?.ltp);
    if (!Number.isFinite(ltp)) throw new Error("LTP not available");
    return ltp;
  }

  async function angelPlaceOrder({
    accessToken,
    apiKey,
    exchange,
    tradingsymbol,
    symboltoken,
    transaction_type,
    quantity,
  }) {
    // Angel place order
    const url =
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder";
    const payload = {
      variety: "NORMAL",
      tradingsymbol,
      symboltoken,
      transactiontype: transaction_type, // BUY/SELL
      exchange, // NFO/NSE
      ordertype: "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      price: "0",
      squareoff: "0",
      stoploss: "0",
      quantity: String(quantity),
      triggerprice: "0",
      disclosedquantity: "0",
    };
    const res = await axios.post(url, payload, {
      headers: angelHeaders(accessToken, apiKey),
    });
    return res.data;
  }

  async function exitOpenTrades(runKeys) {
    for (const key of runKeys) {
      try {
        const lastTrade = await TradeLog.findDoc(
          { brokerKeyId: key.id, type: "entry" },
          { allowNull: true },
        );
        if (!lastTrade) {
          if (!key.status) continue;
          key.status = false;
          console.log(
            "No last trade, marking key as inactive, closing time",
            key.id,
          );
          await key.save();
          continue;
        }
        const parts = String(lastTrade.asset).split(":");
        const exchange = parts[0] || "NFO";
        const tradingsymbol = parts[1];
        const symboltoken = parts[2];
        await angelPlaceOrder({
          accessToken: key.token,
          apiKey: key.apiKey, // store Angel API key here; if different field, adjust
          exchange,
          tradingsymbol,
          symboltoken,
          transaction_type: "SELL",
          quantity: lastTrade.quantity,
        });
        lastTrade.type = "exit";
        await lastTrade.save();
        key.status = false;
        await key.save();
        console.log("Exited and deactivated", key.id);
      } catch (err) {
        console.log("Exit error:", err?.response?.data || err.message);
      }
    }
  }

  cron.schedule("* * * * * *", async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const istNow = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
      );
      const h = istNow.getHours();
      const m = istNow.getMinutes();
      const s = istNow.getSeconds();

      const preRange =
        (h === 8 && m >= 30) || (h > 8 && h < 15) || (h === 15 && m <= 30);
      const isInMarketRange =
        (h === 9 && m >= 30) || (h > 9 && h < 15) || (h === 15 && m <= 15);
      if (!preRange && !isInMarketRange) return;

      if (preRange) {
        if (!dailyLevels) {
          const [rows] = await sequelize.query(
            `SELECT * FROM "DailyLevels" WHERE "forDay"='${getISTMidnightFakeUTCString()}'`,
          );
          dailyLevels = rows[0];
        }

        if (!dailyAsset) {
          const day = dayMap[istNow.getDay()];
          const [rows] = await sequelize.query(
            `SELECT "name", "zerodhaToken", "Assets"."id" FROM "DailyAssets"
             INNER JOIN "Assets" ON "DailyAssets"."assetId" = "Assets"."id"
             WHERE "day"='${day}'`,
          );
          if (!rows.length)
            return console.log("❌ No asset available for today");
          dailyAsset = rows[0];
        }

        if (!keys || !adminKeys || (m % 1 === 0 && s % 40 === 0)) {
          const responseKeys = await BrokerKey.findAll({
            include: [{ model: Broker, where: { name: "Angel One" } }],
            where: { status: true },
          });
          const [admin] = await sequelize.query(
            `SELECT * FROM "BrokerKeys"
             INNER JOIN "Users" ON "BrokerKeys"."userId" = "Users"."id"
             INNER JOIN "Brokers" ON "BrokerKeys"."brokerId" = "Brokers"."id"
             WHERE "Users"."role" = 'admin' AND "Brokers"."name" = 'Zerodha'`,
          );
          adminKeys = admin[0];
          keys = responseKeys;
        }

        // Hard exit at 15:15
        if (h === 15 && m === 15) return await exitOpenTrades(keys);
      }

      if (isInMarketRange && s % 10 === 0) {
        // Zerodha historical candle for signal (same as your other services)
        const toTime = toKiteISTFormat(istNow);
        const fromTime = toKiteISTFormat(
          new Date(istNow.getTime() - 5 * 60 * 1000),
        );
        const instrumentToken = dailyAsset.zerodhaToken;
        const interval = "5minute";
        const url = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(fromTime)}&to=${encodeURIComponent(toTime)}&continuous=false`;

        const hist = await axios.get(url, {
          headers: {
            "X-Kite-Version": "3",
            Authorization: `token ${adminKeys.apiKey}:${adminKeys.token}`,
          },
        });

        const candles = hist?.data?.data?.candles;
        if (!Array.isArray(candles) || candles.length === 0) {
          console.log("⚠️ No candle data available");
          return;
        }
        const latest = candles[candles.length - 1];
        const price = latest[4];
        if (price == null) return console.log("⚠️ Invalid Price");

        // Levels logic same as your files
        const { bc, tc, r1, r2, r3, r4, s1, s2, s3, s4 } = dailyLevels;
        const BUFFER = dailyLevels.buffer;

        let signal = "No Action";
        let direction; // "CE" or "PE"
        let assetPrice;

        if (price % 100 > 50) {
          assetPrice = parseInt(price / 100) * 100 + 100;
        } else {
          assetPrice = parseInt(price / 100) * 100;
        }

        if (price >= tc && price <= tc + BUFFER) {
          direction = "CE";
          signal = "Buy";
        } else if (price <= bc && price >= bc - BUFFER) {
          direction = "PE";
          signal = "Sell";
        } else if (price < tc && price > bc) {
          signal = "Exit";
        }

        const levelsMap = { r1, r2, r3, r4, s1, s2, s3, s4 };
        for (const [_, level] of Object.entries(levelsMap)) {
          if (price > level && price <= level + BUFFER) {
            signal = "Buy";
            direction = "CE";
          } else if (price < level && price >= level - BUFFER) {
            signal = "Sell";
            direction = "PE";
          }
        }

        if (direction === "CE") assetPrice += 400;
        else if (direction === "PE") assetPrice -= 400;

        let resolved = null;
        if (direction) {
          resolved = resolveAngelOption(dailyAsset.name, assetPrice, direction);
          if (!resolved) {
            console.log(
              "⚠️ Could not resolve Angel option for",
              dailyAsset.name,
              assetPrice,
              direction,
            );
          }
        }

        console.log({ istNow, price, direction, signal });

        for (const key of keys) {
          try {
            const apiKey = key.apiKey; // ensure your BrokerKey row holds Angel API key here
            const accessToken = key.token; // JWT
            const balance =
              Number(key.balance) || (await angelGetFunds(accessToken, apiKey));
            const usableFunds = (balance / 100) * 10;

            let ltp = null;
            let lots = null;

            if (direction && resolved?.symboltoken) {
              ltp = await angelGetLTP(resolved, accessToken, apiKey);
              lots = Math.floor(usableFunds / (ltp * resolved.lot_size));
              if (!Number.isFinite(lots) || lots <= 0) continue;
            }

            const pnl = await angelGetTodaysPnL(accessToken, apiKey);
            const maxLoss = (balance / 100) * 4;
            const maxProfit = (balance / 100) * 8;

            const lastTrade = await TradeLog.findDoc(
              { brokerKeyId: key.id, type: "entry" },
              { allowNull: true },
            );

            // Day limits
            if (pnl + maxLoss <= 0 || pnl >= maxProfit) {
              if (!lastTrade) {
                key.status = false;
                await key.save();
                console.log("Limit reached, deactivated", key.id);
                continue;
              }
              const parts = String(lastTrade.asset).split(":");
              await angelPlaceOrder({
                accessToken,
                apiKey,
                exchange: parts[0] || "NFO",
                tradingsymbol: parts[1],
                symboltoken: parts[2],
                transaction_type: "SELL",
                quantity: lastTrade.quantity,
              });
              lastTrade.type = "exit";
              await lastTrade.save();
              key.status = false;
              await key.save();
              console.log("Exited and deactivated due to limit", key.id);
              continue;
            }

            if (s >= 10) continue;
            if (m % 5 !== 0) continue;
            if (signal === "No Action") continue;

            // Exit-only signals
            if (
              signal === "Exit" ||
              signal === "PE Exit" ||
              signal === "CE Exit"
            ) {
              if (!lastTrade) continue;
              if (signal === "PE Exit" && lastTrade.direction !== "PE")
                continue;
              if (signal === "CE Exit" && lastTrade.direction !== "CE")
                continue;
              const parts = String(lastTrade.asset).split(":");
              await angelPlaceOrder({
                accessToken,
                apiKey,
                exchange: parts[0] || "NFO",
                tradingsymbol: parts[1],
                symboltoken: parts[2],
                transaction_type: "SELL",
                quantity: lastTrade.quantity,
              });
              lastTrade.type = "exit";
              await lastTrade.save();
              continue;
            }

            if (!resolved?.symboltoken) continue;

            const orderQty = lots * resolved.lot_size;

            if (lastTrade) {
              if (lastTrade.direction === direction) continue;
              // Flip: exit old, enter new
              const parts = String(lastTrade.asset).split(":");
              await angelPlaceOrder({
                accessToken,
                apiKey,
                exchange: parts[0] || "NFO",
                tradingsymbol: parts[1],
                symboltoken: parts[2],
                transaction_type: "SELL",
                quantity: lastTrade.quantity,
              });
              lastTrade.type = "exit";
              await lastTrade.save();

              await angelPlaceOrder({
                accessToken,
                apiKey,
                exchange: resolved.exchange,
                tradingsymbol: resolved.tradingsymbol,
                symboltoken: resolved.symboltoken,
                transaction_type: "BUY",
                quantity: orderQty,
              });

              await TradeLog.create({
                brokerId: key.brokerId,
                brokerKeyId: key.id,
                userId: key.userId,
                baseAssetId: dailyAsset.id,
                asset: `${resolved.exchange}:${resolved.tradingsymbol}:${resolved.symboltoken}`,
                direction,
                quantity: orderQty,
                type: "entry",
              });
            } else {
              // Fresh entry
              await angelPlaceOrder({
                accessToken,
                apiKey,
                exchange: resolved.exchange,
                tradingsymbol: resolved.tradingsymbol,
                symboltoken: resolved.symboltoken,
                transaction_type: "BUY",
                quantity: orderQty,
              });
              await TradeLog.create({
                brokerId: key.brokerId,
                brokerKeyId: key.id,
                userId: key.userId,
                baseAssetId: dailyAsset.id,
                asset: `${resolved.exchange}:${resolved.tradingsymbol}:${resolved.symboltoken}`,
                direction,
                quantity: orderQty,
                type: "entry",
              });
            }
          } catch (e) {
            console.log(e?.response?.data || e.message);
          }
        }
      }
    } catch (e) {
      if (axios.isAxiosError(e)) {
        console.error("❌ Cron Error:", e.message);
        if (e.response) {
          console.error("📉 Response Data:", e.response.data);
          console.error("📊 Status Code:", e.response.status);
        }
      } else {
        console.error("❌ Unknown Error:", e.message);
      }
    } finally {
      isRunning = false;
    }
  });

  // Stop endpoint (exit all AngelOne keys)
  server.post("/stop/:id?", async (req, res) => {
    try {
      const { id } = req.params;
      let targetKeys = id
        ? await BrokerKey.findDocById(id)
        : await BrokerKey.findAll({
            include: [{ model: Broker, where: { name: "Angel One" } }],
            where: { status: true },
          });

      targetKeys = Array.isArray(targetKeys) ? targetKeys : [targetKeys];
      if (targetKeys.length) await exitOpenTrades(targetKeys);

      res
        .status(200)
        .json({ status: true, message: "Deactivated for the day" });
    } catch (e) {
      console.log(e);
      res.status(500).json({ status: false, message: "Failed" });
    }
  });

  server.listen(3004, () => console.log("Angel One running on PORT 3004"));
})();
