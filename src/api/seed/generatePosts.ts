import { faker } from "@faker-js/faker";
import { Constants } from "../../Breads-Shared/Constants/index.js";
import Category from "../models/category.model.js";
import Post from "../models/post.model.js";

const { PUBLIC, ONLY_FOLLOWERS, ONLY_ME, PRE_ACCEPT } = Constants.POST_STATUS;

const randomStatus = () => {
  const r = Math.random();
  if (r < 0.8) return PUBLIC;
  if (r < 0.9) return ONLY_FOLLOWERS;
  if (r < 0.95) return ONLY_ME;
  return PRE_ACCEPT;
};

const randomMedia = (mediaRate) => {
  const hasMedia = Math.random() < mediaRate;
  if (!hasMedia) return [];
  const count = Math.floor(Math.random() * 3) + 1;
  return Array.from({ length: count }, () => ({
    url: `https://picsum.photos/seed/${faker.string.alphanumeric(12)}/600/400`,
    type: Constants.MEDIA_TYPE.IMAGE,
  }));
};

const buildPost = (authorId, categoryIds, mediaRate) => ({
  authorId,
  content: faker.lorem.sentence({ min: 3, max: 40 }).slice(0, 500),
  media: randomMedia(mediaRate),
  type: "create",
  status: randomStatus(),
  categories: categoryIds.length
    ? faker.helpers.arrayElements(categoryIds, { min: 0, max: 3 })
    : [],
  createdAt: faker.date.past({ years: 1 }),
});

export const seedPosts = async ({
  count,
  authorPool,
  batchSize = 2000,
  mediaRate = 0.4,
  onProgress,
}) => {
  const categoryIds = (await Category.find({}, { _id: 1 }).lean()).map(
    ({ _id }) => _id
  );

  let inserted = 0;
  while (inserted < count) {
    const size = Math.min(batchSize, count - inserted);
    const batch = Array.from({ length: size }, () =>
      buildPost(authorPool.sample(), categoryIds, mediaRate)
    );

    try {
      await Post.insertMany(batch, { ordered: false });
    } catch (err) {
      console.log(
        `\nseedPosts: ${err.writeErrors?.length ?? "some"} docs failed in this batch`
      );
    }

    inserted += size;
    onProgress?.(inserted, count);
  }
};
