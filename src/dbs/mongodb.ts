import mongoose from "mongoose";
import dotenv from "dotenv";
import logger from "../core/logger.ts";
dotenv.config();

const connectionStr = process.env.MONGO_URI || "mongodb://localhost:27017";

class Database {
  static instance: any;
  constructor() {
    this.connect();
  }

  connect() {
    if (process.env.NODE_ENV === "dev") {
      mongoose.set("debug", true);
      mongoose.set("debug", { color: true });
    }

    mongoose.connect(connectionStr).catch((err) => {
      logger.error({ err }, "Error connecting to MongoDB");
    });
  }

  static getInstance() {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }
}

const instanceMongoDB = Database.getInstance();

export default instanceMongoDB;
