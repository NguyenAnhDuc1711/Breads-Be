import cron from "node-cron";
import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { destructObjectId } from "../utils";
import { getPostsCatesByIds } from "../api/services/post";
import User from "../api/models/user.model";
import { ObjectId } from "../utils";
import logger from "../core/logger";

export const createDailyCollectionCron = () => {
  cron.schedule("0 0 * * *", () => {
    createDailyCollection();
  });
};

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
  const uri = "mongodb://localhost:27017";
  const dbName = "Breads-analytics";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);

    // Get collections
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map((col) => col.name);

    // Filter collections based on date range
    const filteredCollections = collectionNames.filter((name) => {
      const splitCollectionName = name.split("-");
      const date = splitCollectionName[0];
      const month = splitCollectionName[1];
      const year = splitCollectionName[2];
      const dateTime = new Date(`${year}-${month}-${date}`).getTime();
      return dateTime >= startDateTime && dateTime <= endDateTime;
    });

    let userActions = [];

    for (const collectionName of filteredCollections) {
      const collection = db.collection(collectionName);
      const actions = await collection.find(query, project).toArray();
      userActions.push(...actions);
    }

    return userActions;
  } catch (error) {
    return [];
  } finally {
    client.close();
  }
};

const createDailyCollection = async () => {
  try {
    const analyticsDB = mongoose.createConnection(process.env.ANALYTICS_DB_URI);
    const now = new Date();
    const dateString = now.toLocaleDateString("en-GB");
    const collectionName = dateString.replace(/\//g, "-");
    await analyticsDB.createCollection(collectionName);
  } catch (err) {
    if (err.codeName !== "NamespaceExists") {
      logger.error({ err }, "createDailyCollection failed");
    }
  }
};
