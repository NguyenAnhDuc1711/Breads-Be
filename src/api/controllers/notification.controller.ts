import { Constants } from "../../Breads-Shared/Constants/index.js";
import { AuthFailureError, NotFoundError } from "../../core/error.response.js";
import { OK } from "../../core/success.response.js";
import { ObjectId } from "../../utils/index.js";
import Notification from "../models/notification.model.js";
import User from "../models/user.model.js";

export const getNotifications = async (req, res) => {
  if (!req.user) {
    throw new AuthFailureError("Unauthorized");
  }
  const { page, limit, action } = req.query;
  const skip = (page - 1) * limit;
  const notifications = await Notification.aggregate([
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

export const readNotifications = async (req, res) => {
  if (!req.user) {
    throw new AuthFailureError("Unauthorized");
  }
  const uid = ObjectId(req.user._id);
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
      { toUsers: { $in: [uid] }, isRead: { $ne: true } },
      { isRead: true }
    );
  }

  const stillUnread = await Notification.exists({
    toUsers: { $in: [uid] },
    isRead: { $ne: true },
  });
  await User.updateOne({ _id: uid }, { hasNewNotify: !!stillUnread });

  new OK({
    message: "Notifications marked as read",
    metadata: { hasNewNotify: !!stillUnread },
  }).send(res);
};
