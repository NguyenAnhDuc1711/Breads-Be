import mongoose from "mongoose";
import dotenv from "dotenv";
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

    mongoose
      .connect(connectionStr)
      .then(() => {
        console.log("Connected to MongoDB");
      })
      .catch((err) => {
        console.log("Error connecting to MongoDB", err);
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
