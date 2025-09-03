import axios from "axios";
import {
  resolveAngelOption,
  loadAngelScripMaster,
} from "./angelInstruments.util.js";
import { configDotenv } from "dotenv";

configDotenv();

await loadAngelScripMaster();

async function placeIntradayOrder({
  name, // e.g. "BANKNIFTY"
  strike, // e.g. 53000
  optionType, // "CE" or "PE"
  transactionType = "BUY", // BUY / SELL
  quantity = 1,
}) {
  try {
    // 🔹 Resolve instrument from scrip master
    let instrument = resolveAngelOption(name, strike, optionType);
    if (!instrument) throw new Error("Instrument not found in scrip master");

    instrument = {
      token: "47570",
      symbol: "NIFTY23SEP2524000CE",
      name: "NIFTY",
      expiry: "23SEP2025",
      strike: "2400000.000000",
      lotsize: "75",
      instrumenttype: "OPTIDX",
      exch_seg: "NFO",
      tick_size: "5.000000",
    };

    // 🔹 Build order payload
    const data = {
      variety: "NORMAL",
      tradingsymbol: instrument.symbol,
      symboltoken: instrument.token,
      transactiontype: transactionType,
      exchange: instrument.exch_seg,
      ordertype: "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      price: "0", // MARKET order
      squareoff: "0",
      stoploss: "0",
      quantity: String(quantity * instrument.lotsize), // multiply by lot size
    };

    // 🔹 Axios config
    const config = {
      method: "post",
      url: "https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder",
      headers: {
        Authorization: `Bearer ${process.env.TOKEN}`, // your JWT
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": process.env.ANGEL_API_KEY, // your API key
      },
      data,
    };

    // 🔹 Send order
    const response = await axios(config);
    console.log("✅ Order placed:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ Order error:", err.response?.data || err.message);
    throw err;
  }
}

// 🟢 Example usage
await placeIntradayOrder({
  name: "NIFTY",
  strike: 24000,
  optionType: "CE",
  transactionType: "BUY",
  quantity: 1, // number of lots
});

async function getBalance() {
  try {
    const response = await axios.get(
      "https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS",
      {
        headers: {
          Authorization: `Bearer ${process.env.TOKEN}`, // your login access token
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-UserType": "USER",
          "X-SourceID": "WEB",
          "X-ClientLocalIP": "127.0.0.1",
          "X-ClientPublicIP": "127.0.0.1",
          "X-MACAddress": "00:00:00:00:00:00",
          "X-PrivateKey": process.env.ANGEL_API_KEY,
        },
      },
    );

    console.log("✅ Balance:", response.data);
    return response.data;
  } catch (err) {
    console.error(
      "❌ Error fetching balance:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

await getBalance();

async function getHistoricalData({
  symboltoken,
  exchange = "NSE",
  interval = "ONE_MINUTE",
  fromDate,
  toDate,
}) {
  try {
    const response = await axios.post(
      "https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData",
      {
        exchange, // NSE / NFO / BSE
        symboltoken, // e.g. "3045" for INFY
        interval, // ONE_MINUTE, THREE_MINUTE, FIVE_MINUTE, TEN_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, ONE_DAY
        fromdate: fromDate, // format: YYYY-MM-DD HH:mm
        todate: toDate, // format: YYYY-MM-DD HH:mm
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TOKEN}`, // JWT access token from login
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-UserType": "USER",
          "X-SourceID": "WEB",
          "X-ClientLocalIP": "127.0.0.1",
          "X-ClientPublicIP": "127.0.0.1",
          "X-MACAddress": "00:00:00:00:00:00",
          "X-PrivateKey": process.env.ANGEL_API_KEY,
        },
      },
    );

    console.log("✅ Historical Data:", response.data.data);
    return response.data.data;
  } catch (err) {
    console.error(
      "❌ Error fetching historical data:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

// Example usage:
await getHistoricalData({
  symboltoken: "99926000", // INFY-EQ (from scrip master)
  exchange: "NSE",
  interval: "FIVE_MINUTE",
  fromDate: "2025-08-01 09:15",
  toDate: "2025-08-29 15:30",
});

async function getNifty50Instrument() {
  const url =
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

  const { data } = await axios.get(url);

  console.log(`✅ Loaded ${data.length} instruments`);

  // Find NIFTY 50 index from NSE segment
  const nifty = data.find(
    (s) =>
      s.symbol === "NIFTY50" &&
      s.name === "NIFTY" && // Some rows show NIFTY / NIFTY 50
      s.instrumenttype === "INDEX",
  );

  if (!nifty) {
    throw new Error("❌ NIFTY50 not found in Scrip Master");
  }

  return nifty;
}

(async () => {
  try {
    const nifty = await getNifty50Instrument();
    console.log("🟢 NIFTY50 instrument:", nifty);
  } catch (err) {
    console.error(err.message);
  }
})();
