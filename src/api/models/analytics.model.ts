import mongoose from "mongoose";

const now = new Date();
const dateString = now.toLocaleDateString("en-GB"); // Format: DD/MM/YYYY
const collectionName = dateString.replace(/\//g, "-"); // Replace "/" with "-"

const analyticsSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    payload: { type: Object },
    deviceInfo: { type: Object },
    browserInfo: { type: Object },
    localeInfo: { type: Object },
    webInfo: { type: Object },
  },
  {
    timestamps: true, // Optional: Automatically adds createdAt and updatedAt fields
    collection: collectionName, // Specify the dynamic collection name
  }
);

const analyticsDB = mongoose.createConnection(process.env.ANALYTICS_DB_URI);
const AnalyticsModel = analyticsDB.model("Analytics", analyticsSchema);
export default AnalyticsModel;
