import Notification from "../../api/models/notification.model.js";
import User from "../../api/models/user.model.js";
import { NOTIFICATION_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import { ObjectId } from "../../utils/index.js";
import { getUserSocketsByUserIds } from "../services/user.js";
import logger from "../../core/logger.js";
export default class NotificationController {
  static create = async (payload, socket, io) => {
    try {
      const { fromUser, toUsers, action, target } = payload;
      const authUserId = (socket as any).user?.userId;
      if (!authUserId || authUserId !== fromUser) {
        logger.warn(
          { socketId: socket.id, fromUser },
          "notifications/create rejected: identity mismatch"
        );
        return;
      }
      const sendTo = toUsers?.filter((userId) => userId !== fromUser);
      if (!sendTo?.length || fromUser === toUsers[0]) {
        return;
      }
      const existingNotifications = await Notification.find({
        fromUser: ObjectId(fromUser),
        toUsers: { $in: toUsers?.map((userId) => ObjectId(userId)) },
        action: action,
        // Nhánh falsy phải tường minh `$exists: false`. Gán key target bằng giá trị
        // undefined thì Mongoose strip key đó đi, điều kiện biến mất và bug A12 tái
        // tạo nguyên vẹn trong khi test FOLLOW vẫn pass.
        ...(target
          ? { target: ObjectId(target) }
          : { target: { $exists: false } }),
      });
      if (existingNotifications.length > 0) {
        const notificationIds = existingNotifications.map((notification) =>
          ObjectId(notification._id)
        );
        await Notification.deleteMany({
          _id: { $in: notificationIds },
        });
        return;
      }

      let notificationInfo: any = {
        fromUser: fromUser,
        toUsers: sendTo,
        action,
      };
      if (target) {
        notificationInfo.target = target;
      }
      notificationInfo = new Notification(notificationInfo);
      const newNotification = await notificationInfo.save();
      const notification = await Notification.aggregate([
        { $match: { _id: ObjectId(newNotification._id) } },
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
        {
          $unwind: {
            path: "$postDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
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
            createdAt: 1,
            FromUserDetails: 1,
            "postDetails.content": 1,
            // Phải là $ifNull, không phải projection inclusion: aggregate bỏ qua
            // schema/default của Mongoose nên key biến mất hoàn toàn trên document
            // legacy chưa có field này.
            isRead: { $ifNull: ["$isRead", false] },
          },
        },
      ]);
      // `sendTo` (đã lọc `fromUser`), không phải `toUsers` thô — và mọi socket của
      // mọi recipient, không phải một socket duy nhất.
      const socketIds = await getUserSocketsByUserIds(sendTo, io);
      for (const id of socketIds) {
        io.to(id).emit(
          Route.NOTIFICATION + NOTIFICATION_PATH.GET_NEW,
          notification?.[0]
        );
      }

      await User.updateMany(
        { _id: { $in: sendTo.map((u) => ObjectId(u)) } },
        { hasNewNotify: true }
      );
    } catch (err) {
      logger.error(
        { err, socketId: socket?.id },
        "NotificationController.create failed"
      );
    }
  };
}
