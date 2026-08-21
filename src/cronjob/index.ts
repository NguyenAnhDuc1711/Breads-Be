import cron from "node-cron";
import { MongoClient } from "mongodb";
import { destructObjectId } from "../utils";
import { getPostsCatesByIds } from "../api/services/post";
import User from "../api/models/user.model";
import { ObjectId } from "../utils";
import logger from "../core/logger";

export const updateUsersCatesCron = async () => {
  const updateAfterDays = 7;
  cron.schedule(`0 0 */${updateAfterDays} * *`, async () => {
    const currentDateTime = new Date().getTime();
    const timePerDay = 1000 * 60 * 60 * 24;
    const prevDateTime = currentDateTime - timePerDay * updateAfterDays;
    const query = {
      event: {
        $in: [
          "like_post",
          "copy_post_link",
          "save_post",
          "repost_post",
          "create_post",
          "see_detail_post",
        ],
      },
    };
    const project = {
      userId: 1,
      payload: 1,
    };
    const eventData = await getUsersEventsFromRange(
      prevDateTime,
      currentDateTime,
      query,
      project
    );
    const processedData = {};
    eventData?.forEach(({ userId, payload }) => {
      const postId = destructObjectId(payload?.postId);
      const destructUserId = destructObjectId(userId);
      if (`${destructUserId}` in processedData) {
        const isValidPostId = processedData[destructUserId]?.find(
          (id) => id === postId
        );
        if (!isValidPostId) {
          processedData[destructUserId].push(postId);
        }
      } else {
        processedData[destructUserId] = [postId];
      }
    });
    const promises = [];
    for (const [userId, postIds] of Object.entries(processedData)) {
      const cateIds = await getPostsCatesByIds({ postIds });
      promises.push(
        User.updateOne(
          {
            _id: ObjectId(userId),
          },
          {
            catesCare: cateIds,
          }
        )
      );
    }
    await Promise.all(promises);
  });
};

const getUsersEventsFromRange = async (
  startDateTime,
  endDateTime,
  query,
  project
) => {
  const client = new MongoClient(process.env.ANALYTICS_DB_URI);

  try {
    await client.connect();
    const db = client.db();
    const collection = db.collection("events");

    const rangeQuery = {
      ...query,
      createdAt: {
        $gte: new Date(startDateTime),
        $lte: new Date(endDateTime),
      },
    };

    return await collection
      .find(rangeQuery, { projection: project })
      .toArray();
  } catch (error) {
    logger.error({ err: error }, "getUsersEventsFromRange failed");
    return [];
  } finally {
    client.close();
  }
};
