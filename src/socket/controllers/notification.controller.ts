import Notification from "../../api/models/notification.model.js";
import User from "../../api/models/user.model.js";
import { NOTIFICATION_PATH, Route } from "../../Breads-Shared/APIConfig.js";
import { ObjectId } from "../../utils/index.js";
import { getUserSocketByUserId } from "../services/user.js";
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
          },
        },
      ]);
      const targetUserSocketId = await getUserSocketByUserId(toUsers, io);
      if (targetUserSocketId) {
        io.to(targetUserSocketId).emit(
          Route.NOTIFICATION + NOTIFICATION_PATH.GET_NEW,
          notification?.[0]
        );
      }

      await User.updateOne({ _id: ObjectId(toUsers) }, { hasNewNotify: true });
    } catch (err) {
      logger.error(
        { err, socketId: socket?.id },
        "NotificationController.create failed"
      );
    }
  };
}
