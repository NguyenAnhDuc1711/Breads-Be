import { Constants } from "../../Breads-Shared/Constants/index.js";
import { AuthFailureError, NotFoundError } from "../../core/error.response.js";
import { OK } from "../../core/success.response.js";
import { ObjectId } from "../../utils/index.js";
import Notification from "../models/notification.model.js";
import User from "../models/user.model.js";

export const getNotifications = async (req, res) => {
  // A-4: `protectRoute` gán thẳng kết quả `User.findById` vào `req.user` mà KHÔNG return sớm khi
  // `null` (token hợp lệ của user đã bị xoá). Guard phải đứng trước mọi `ObjectId(...)` vì
  // `ObjectId(undefined)` sinh id NGẪU NHIÊN thay vì throw -> response rỗng im lặng thay vì 401.
  if (!req.user) {
    throw new AuthFailureError("Unauthorized");
  }
  const { page, limit, action } = req.body;
  const skip = (page - 1) * limit;
  const notifications = await Notification.aggregate([
    // FR-6: `"all"` là sentinel tab "Tất cả" = KHÔNG lọc (không document nào có `action: "all"`).
    // `$match` giữ nguyên vị trí trước `$sort`/`$skip`/`$limit` để phân trang tính trên tập đã lọc.
    {
      $match: {
        toUsers: ObjectId(req.user._id),
        ...(action && action !== Constants.NOTIFICATION_ACTION.ALL
          ? { action }
          : {}),
      },
    },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: "users",
        localField: "fromUser",
        foreignField: "_id",
        as: "fromUserDetails",
      },
    },
    { $unwind: "$fromUserDetails" },
    {
      $lookup: {
        from: "posts",
        localField: "target",
        foreignField: "_id",
        as: "postDetails",
      },
    },
    { $unwind: { path: "$postDetails", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        FromUserDetails: {
          $cond: {
            if: { $eq: ["$action", "follow"] },
            then: {
              _id: "$fromUserDetails._id",
              name: "$fromUserDetails.name",
              username: "$fromUserDetails.username",
              bio: "$fromUserDetails.bio",
              avatar: "$fromUserDetails.avatar",
            },
            else: {
              username: "$fromUserDetails.username",
              avatar: "$fromUserDetails.avatar",
            },
          },
        },
      },
    },
    {
      $project: {
        fromUser: 1,
        toUsers: 1,
        action: 1,
        target: 1,
        // ARCH-1: aggregate đọc thẳng từ MongoDB, BỎ QUA schema/default của Mongoose. Projection
        // dạng inclusion (`<field>` -> 1) trên document legacy (thiếu key trên đĩa) sẽ bỏ hẳn key
        // khỏi output -> SC-12 fail trên đúng tập document lớn nhất.
        isRead: { $ifNull: ["$isRead", false] },
        createdAt: 1,
        FromUserDetails: 1,
        "postDetails.content": 1,
      },
    },
  ]);

  new OK({
    message: "Notifications fetched successfully",
    metadata: notifications,
  }).send(res);
};

// FR-3 (task 010): PATCH /notifications/read — mark-read (1 document hoặc tất cả) rồi recompute
// `User.hasNewNotify` bằng 1 truy vấn `Notification.exists` trong chính request (AD-5 — không
// counter field, không Mongoose hook, không migration).
//
// ARCH-1: ~370k document Notification legacy KHÔNG có key `isRead` trên đĩa. `default: false` của
// Mongoose chỉ áp lúc TẠO document mới, không áp lúc query. Điều kiện "chưa đọc" PHẢI là
// `isRead: { $ne: true }` — TUYỆT ĐỐI KHÔNG so sánh isRead với giá trị false trực tiếp — ở cả
// `updateMany` lẫn `exists`.
export const readNotifications = async (req, res) => {
  // A-4: guard trước mọi ObjectId(...) — ObjectId(undefined) sinh id NGẪU NHIÊN thay vì throw.
  if (!req.user) {
    throw new AuthFailureError("Unauthorized");
  }
  const uid = ObjectId(req.user._id);
  // Schema (XOR) đã đảm bảo đúng 1 trong 2 key tồn tại — chỉ cần đọc `notificationId`; nhánh
  // `else` tự động là `markAll` (`noUnusedLocals` cấm destructure `markAll` rồi bỏ không dùng).
  const { notificationId } = req.body;

  if (notificationId) {
    const result = await Notification.updateOne(
      { _id: ObjectId(notificationId), toUsers: { $in: [uid] } },
      { isRead: true }
    );
    if (result.matchedCount === 0) {
      throw new NotFoundError("Notification not found");
    }
  } else {
    await Notification.updateMany(
      { toUsers: { $in: [uid] }, isRead: { $ne: true } }, // ⚠️ $ne: true — ARCH-1
      { isRead: true }
    );
  }

  const stillUnread = await Notification.exists({
    toUsers: { $in: [uid] },
    isRead: { $ne: true }, // ⚠️ $ne: true — ARCH-1
  });
  await User.updateOne({ _id: uid }, { hasNewNotify: !!stillUnread });

  new OK({
    message: "Notifications marked as read",
    metadata: { hasNewNotify: !!stillUnread },
  }).send(res);
};
