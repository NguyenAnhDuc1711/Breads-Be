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

// Tách khỏi `likePost` vì `likePost` gọi `getCollection(Model.POST)` (`src/utils/index.ts`), hàm
// này throw khi không có Mongo connection thật -> `likePost` không chạy được end-to-end trong test
// suite (không có harness Mongo, NFR-2 cấm thêm dependency). Đây là điều kiện cần để có test
// coverage cho fix FR-4 (A12b), cùng pattern `dispatchFanout` đã tách khỏi `createPost`
// (xem `src/api/controllers/post.controller.dispatch.test.ts`).
export const deleteLikeNotification = async ({
  fromUserId,
  toUserId,
  postId,
}: {
  fromUserId: any;
  toUserId: any;
  postId: any;
}) => {
  await Notification.deleteOne({
    fromUser: ObjectId(fromUserId),
    toUsers: { $in: [toUserId] },
    action: Constants.NOTIFICATION_ACTION.LIKE,
    target: ObjectId(postId),
  });
};

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
        await deleteLikeNotification({
          fromUserId: userId,
          toUserId: postInfo.authorId,
          postId,
        });
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
                isRead: { $ifNull: ["$isRead", false] },
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
