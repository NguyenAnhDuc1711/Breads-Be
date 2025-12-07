import { BadRequestError } from "../../core/error.response.js";
import { OK } from "../../core/success.response.js";
import { ObjectId } from "../../utils/index.js";
import Notification from "../models/notification.model.js";

export const getNotifications = async (req, res) => {
  const { userId, page, limit } = req.body;
  if (!userId) {
    throw new BadRequestError("Empty userId");
  }
  const skip = (page - 1) * limit;
  const notifications = await Notification.aggregate([
    { $match: { toUsers: ObjectId(userId) } },
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
