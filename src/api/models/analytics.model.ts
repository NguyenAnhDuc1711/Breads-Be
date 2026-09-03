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
// Bước 5 (access-control-hardening): `getSnapshotReport` lọc THUẦN theo `createdAt` (range, không
// kèm `userId`/`event`), nên index compound ở trên KHÔNG dùng được — `createdAt` không phải prefix
// -> COLLSCAN toàn collection mỗi lần mở trang Overview. Index đơn này biến nó thành IXSCAN theo
// đúng khoảng ngày, tức chi phí truy vấn tỉ lệ với khoảng ĐƯỢC HỎI (đã bị chặn trần 90 ngày) thay
// vì với tổng số event đã tích luỹ.
analyticsSchema.index({ createdAt: 1 });

const AnalyticsModel = mongoose.model("Analytics", analyticsSchema);
export default AnalyticsModel;
