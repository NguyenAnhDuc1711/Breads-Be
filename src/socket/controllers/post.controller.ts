import Notification from "../../api/models/notification.model.js";
import User from "../../api/models/user.model.js";
import {
  NOTIFICATION_PATH,
  POST_PATH,
  Route,
} from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import {
  destructObjectId,
  getCollection,
  ObjectId,
} from "../../utils/index.js";
import Model from "../../utils/ModelName.js";
import { sendToSpecificUser } from "../services/message.js";
import { Server } from "socket.io";

export default class PostController {
  static likePost = async (payload: any, io: Server) => {
    const { userId, postId } = payload;
    const postInfo = await getCollection(Model.POST).findOne({
      _id: ObjectId(postId),
    });
    if (postInfo) {
      const usersLike = postInfo.usersLike.map((id) => destructObjectId(id));
      const query: any = !usersLike?.includes(userId)
        ? {
            $push: { usersLike: ObjectId(userId) },
          }
        : {
            $pull: { usersLike: ObjectId(userId) },
          };
      await getCollection(Model.POST).updateOne(
        {
          _id: ObjectId(postId),
        },
        query
      );
      const likedBefore = usersLike?.includes(userId);
      const updateList = likedBefore
        ? usersLike.filter((id) => id !== userId)
        : [...usersLike, userId];
      //Handle send notification
      if (likedBefore) {
        const validNotification = await Notification.findOne({
          fromUser: ObjectId(userId),
          "toUsers.0": postInfo.authorId,
        });
        if (validNotification) {
          await Notification.deleteOne({
            _id: validNotification._id,
          });
        }
      } else {
        if (userId !== postInfo.authorId) {
          const notificationInfo = new Notification({
            fromUser: userId,
            toUsers: [postInfo.authorId],
            action: Constants.NOTIFICATION_ACTION.LIKE,
            target: postId,
          });
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
          await sendToSpecificUser({
            recipientId: postInfo.authorId,
            io,
            path: Route.NOTIFICATION + NOTIFICATION_PATH.GET_NEW,
            payload: notification?.[0],
          });
          await User.updateOne(
            {
              _id: postInfo.authorId,
            },
            {
              hasNewNotify: true,
            }
          );
        }
      }
      io.emit(Route.POST + POST_PATH.GET_ONE, {
        usersLike: updateList,
        postId,
      });
    }
  };
}
