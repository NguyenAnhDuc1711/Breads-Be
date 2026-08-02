import Notification from "../../api/models/notification.model.js";
import User from "../../api/models/user.model.js";
import {
  NOTIFICATION_PATH,
  POST_PATH,
  Route,
} from "../../Breads-Shared/APIConfig.js";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import { getCollection, ObjectId } from "../../utils/index.js";
import Model from "../../utils/ModelName.js";
import { sendToSpecificUser } from "../services/message.js";
import { Server, Socket } from "socket.io";

export default class PostController {
  static likePost = async (payload: any, socket: Socket, io: Server) => {
    const { userId, postId } = payload;
    const authenticatedUserId = (socket as any).user?.userId;
    if (!authenticatedUserId || authenticatedUserId !== userId) {
      return;
    }
    const postInfo = await getCollection(Model.POST).findOne({
      _id: ObjectId(postId),
    });
    if (postInfo) {
      const existingLike = await getCollection(Model.LIKE).findOne({
        postId: ObjectId(postId),
        userId: ObjectId(userId),
      });
      const likedBefore = !!existingLike;
      if (likedBefore) {
        await getCollection(Model.LIKE).deleteOne({ _id: existingLike._id });
      } else {
        await getCollection(Model.LIKE).insertOne({
          postId: ObjectId(postId),
          userId: ObjectId(userId),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      const updatedPost = await getCollection(Model.POST).findOneAndUpdate(
        { _id: ObjectId(postId) },
        { $inc: { likesCount: likedBefore ? -1 : 1 } },
        { returnDocument: "after" },
      );
      const likesCount =
        (updatedPost as any)?.likesCount ??
        (updatedPost as any)?.value?.likesCount ??
        0;
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
        likesCount,
        postId,
      });
    }
  };
}
