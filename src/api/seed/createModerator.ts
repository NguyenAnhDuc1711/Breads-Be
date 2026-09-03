import "dotenv/config.js";
import bcrypt from "bcryptjs";
import { faker } from "@faker-js/faker";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }),
);

const suffix = faker.string.alphanumeric(6).toLowerCase();
const email = args.email ?? `moderator_${suffix}@example.test`;
const username = args.username ?? `moderator_${suffix}`;
const name = args.name ?? `Test Moderator ${suffix}`;
const password = args.password ?? faker.internet.password({ length: 12 });

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017");

  const existing = await User.findOne({ email });
  if (existing) {
    console.error(`A user with email "${email}" already exists (_id=${existing._id}). Pick a different --email or delete it first.`);
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    username,
    email,
    password: hashedPassword,
    role: Constants.USER_ROLE.MODERATOR,
  });

  console.log("Moderator account created:");
  console.log(`  _id:      ${user._id}`);
  console.log(`  email:    ${email}`);
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}`);
  console.log("\nLog in at Breads-Admin's /login with the email/password above.");

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("createModerator failed:", err);
  process.exit(1);
});
