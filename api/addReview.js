// api/addReview.js

import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/*
  This function:
  - Receives review data from your Framer form (POST)
  - Checks content with Google Gemini API (filter)
  - Inserts the review into your Supabase "reviews" table
  - Keeps your Supabase keys and Gemini key secure in Vercel environment
*/

// Initialize Supabase client (server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Gemini API endpoint (you can adjust if Google changes version)
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// Helper to safely parse model output
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Main API handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { business_id, reviewer_name, phone, content } = req.body;

    // Basic field check
    if (!business_id || !reviewer_name || !phone || !content) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Optional: verify secret header (prevents random spam requests)
    const secret = req.headers["x-webhook-secret"];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    // ---------------------------
    // 1️⃣  Call Gemini to filter text
    // ---------------------------
    const prompt = `
    Analyze this review for inappropriate or harmful content.
    Respond ONLY in this exact JSON structure:
    {
      "safety_score": number, // 0 safe, 1 very unsafe
      "sentiment_score": number, // -1 to +1 (negative to positive)
      "action": "allow" | "flag" | "block"
    }
    Review: "${content}"
    `;

    const geminiResponse = await fetch(
      `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );

    const geminiData = await geminiResponse.json();
    const modelText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const result = safeJSON(modelText) || {};

    const safety = result.safety_score ?? 0;
    const sentiment = result.sentiment_score ?? 0;
    const action = result.action ?? "flag";

    // ---------------------------
    // 2️⃣  Decide status based on Gemini result
    // ---------------------------
    let status = "pending";
    if (action === "allow" && safety < 0.3) status = "approved";
    else if (action === "block" || safety >= 0.7) status = "flagged";

    // ---------------------------
    // 3️⃣  Insert into Supabase
    // ---------------------------
    const { error: insertError } = await supabase.from("reviews").insert([
      {
        business_id,
        reviewer_name,
        phone,
        content,
        status,
        sentiment_score: sentiment,
        is_positive: sentiment > 0,
      },
    ]);

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return res.status(500).json({ error: insertError.message });
    }

    // ---------------------------
    // 4️⃣  Respond success
    // ---------------------------
    return res.status(200).json({
      ok: true,
      message: "Review received successfully.",
      status,
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
