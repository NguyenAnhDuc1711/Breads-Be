import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const notificationSchema = new mongoose.Schema(
  {
    fromUser: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    toUsers: [
      {
        type: ObjectId,
        ref: "User",
        required: true,
      },
    ],
    action: {
      type: String,
      required: true,
    },
    target: {
      type: ObjectId,
      ref: "Post",
      required: false,
    },
    isRead: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ toUsers: 1, createdAt: -1 });

// Chặn duplicate notification do race condition (2 event `notifications/create` bắn gần đồng thời
// cùng tạo mới trước khi cái nào kịp thấy cái kia trong bước check-tồn-tại). `partialFilterExpression`
// theo `createdAt` để ràng buộc unique chỉ áp cho document tạo TỪ THỜI ĐIỂM NÀY trở đi — tránh
// phải dedupe/migrate ~370k document legacy (ARCH-1) có thể đã chứa duplicate từ trước khi có index.
notificationSchema.index(
  { fromUser: 1, action: 1, target: 1, toUsers: 1 },
  {
    unique: true,
    partialFilterExpression: {
      createdAt: { $gte: new Date("2026-08-13T00:00:00.000Z") },
    },
  }
);

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
