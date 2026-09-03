import { faker } from "@faker-js/faker";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import User from "../models/user.model.js";
import { randomAvatar } from "../utils/index.js";
import { ObjectIdPool } from "./idPool.js";

const FAKE_PASSWORD = "password123";

const buildUser = (runId, index) => ({
  name: faker.person.fullName(),
  username: `fake_${runId}_${index}`,
  email: `fake_${runId}_${index}@seed.local`,
  password: FAKE_PASSWORD,
  avatar: randomAvatar(),
  bio: faker.lorem.sentence(),
  role: Constants.USER_ROLE.USER,
  status: Constants.USER_STATUS.ACTIVE,
  createdAt: faker.date.past({ years: 2 }),
});

export const seedUsers = async ({
  runId,
  count,
  batchSize = 2000,
  authorPoolCapacity = 300000,
  onProgress,
}) => {
  const pool = new ObjectIdPool(Math.min(authorPoolCapacity, count));
  let inserted = 0;
  let index = 0;

  while (inserted < count) {
    const size = Math.min(batchSize, count - inserted);
    const batch = Array.from({ length: size }, () => buildUser(runId, index++));

    let docs;
    try {
      docs = await User.insertMany(batch, { ordered: false });
    } catch (err) {
      docs = err?.insertedDocs ?? [];
      console.log(
        `\nseedUsers: ${err.writeErrors?.length ?? "some"} docs failed in this batch, ${docs.length} still inserted`
      );
    }
    for (const doc of docs) {
      pool.push(doc._id);
    }

    inserted += size;
    onProgress?.(inserted, count);
  }

  return pool;
};
