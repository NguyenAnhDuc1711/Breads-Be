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
    timestamps: true,
    collection: "events",
  }
);

analyticsSchema.index({ userId: 1, event: 1, createdAt: 1 });
analyticsSchema.index({ createdAt: 1 });

const AnalyticsModel = mongoose.model("Analytics", analyticsSchema);
export default AnalyticsModel;
