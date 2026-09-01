import mongoose from "mongoose";

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
    timestamps: true, // Automatically adds createdAt and updatedAt fields
    collection: "events", // Fixed collection (was: 1 new collection per day)
  }
);

analyticsSchema.index({ userId: 1, event: 1, createdAt: 1 });

const AnalyticsModel = mongoose.model("Analytics", analyticsSchema);
export default AnalyticsModel;
