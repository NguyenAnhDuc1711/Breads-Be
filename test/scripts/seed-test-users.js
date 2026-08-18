#!/usr/bin/env node

/**
 * Seed test users for k6 message stress testing.
 *
 * This script creates 2 test users via direct MongoDB insertion (bypasses
 * the signup flow which requires email verification + Redis), then calls
 * the login API to obtain valid JWT access tokens.
 *
 * Prerequisites:
 *   - MongoDB running at MONGO_URI (default: mongodb://127.0.0.1:27017/Breads)
 *   - Breads-Be server running at BASE_URL (default: http://localhost:8080)
 *
 * Usage:
 *   node test/scripts/seed-test-users.js
 *
 * Environment variables:
 *   MONGO_URI  - MongoDB connection string (default: mongodb://127.0.0.1:27017/Breads)
 *   BASE_URL   - Breads-Be server URL (default: http://localhost:8080)
 *
 * Output (JSON to stdout):
 *   {
 *     "sender":    { "userId": "...", "accessToken": "..." },
 *     "recipient": { "userId": "...", "accessToken": "..." }
 *   }
 */

import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/Breads";
const BASE_URL = process.env.BASE_URL || "http://localhost:8080";

const TEST_PASSWORD = "k6stress123456";

const TEST_USERS = [
  {
    role: "sender",
    name: "K6 Sender",
    username: `k6_sender_${Date.now()}`,
    email: `k6sender_${Date.now()}@test.local`,
  },
  {
    role: "recipient",
    name: "K6 Recipient",
    username: `k6_recipient_${Date.now()}`,
    email: `k6recipient_${Date.now()}@test.local`,
  },
];

async function main() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    const db = client.db();
    const usersCol = db.collection("users");

    const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 10);
    const result = {};

    for (const testUser of TEST_USERS) {
      // Check if a user with this username already exists
      const existing = await usersCol.findOne({ username: testUser.username });
      let userId;

      if (existing) {
        userId = existing._id.toString();
        console.error(`[seed] User "${testUser.username}" already exists: ${userId}`);
      } else {
        const doc = {
          name: testUser.name,
          username: testUser.username,
          email: testUser.email,
          password: hashedPassword,
          avatar:
            "https://as2.ftcdn.net/v2/jpg/04/10/43/77/1000_F_410437733_hdq4Q3QOH9uwh0mcqAhRFzOKfrCR24Ta.jpg",
          bio: "",
          role: 1,
          links: [],
          hasNewNotify: false,
          hasNewMsg: false,
          status: 1,
          followersCount: 0,
          followingCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const insertResult = await usersCol.insertOne(doc);
        userId = insertResult.insertedId.toString();
        console.error(`[seed] Created user "${testUser.username}": ${userId}`);
      }

      // Login to get access token
      const loginRes = await fetch(`${BASE_URL}/api/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: testUser.email,
          password: TEST_PASSWORD,
        }),
      });

      if (!loginRes.ok) {
        throw new Error(
          `Login failed for ${testUser.email}: ${loginRes.status} ${await loginRes.text()}`
        );
      }

      const loginData = await loginRes.json();
      const accessToken = loginData?.metadata?.accessToken;

      if (!accessToken) {
        throw new Error(`No accessToken in login response for ${testUser.email}`);
      }

      result[testUser.role] = {
        userId,
        email: testUser.email,
        username: testUser.username,
        accessToken,
      };

      console.error(`[seed] Got token for "${testUser.role}"`);
    }

    // Output JSON to stdout for piping into k6 env vars
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
