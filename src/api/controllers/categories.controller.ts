import axios from "axios";
import fs from "fs";
import path from "path";
import HTTPStatus from "../../utils/httpStatus.js";
import Category from "../models/category.model.js";
import Post from "../models/post.model.js";
import User from "../models/user.model.js";

export const importCategoriesFromJson = async (req, res) => {
  try {
    // Path to the JSON file (adjust path as needed based on your project structure)
    const jsonPath = path.resolve(
      process.cwd(),
      "data/top_50_categories_with_keywords.json"
    );

    // Read and parse the JSON file
    const categoriesData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    if (!Array.isArray(categoriesData)) {
      return res.status(HTTPStatus.BAD_REQUEST).json({
        error: "Invalid JSON format. Expected an array of categories.",
      });
    }

    // Clear existing categories if needed (optional, based on your requirement)
    const { clearExisting } = req.query;
    if (clearExisting === "true") {
      await Category.deleteMany({});
    }

    // Insert categories
    const result = await Category.insertMany(
      categoriesData.map((category) => ({
        name: category.name,
        keywords: category.keywords,
      }))
    );

    return res.status(HTTPStatus.OK).json({
      message: "Categories imported successfully",
      count: result.length,
      categories: result,
    });
  } catch (err) {
    console.log("importCategoriesFromJson error:", err);
    res.status(HTTPStatus.SERVER_ERR).json({ error: err.message });
  }
};

export const getPostsWithContent = async (req, res) => {
  try {
    // Find posts with non-empty content
    const query = {
      content: { $exists: true, $ne: "" },
    };

    // Count total matching documents for pagination
    const total = await Post.countDocuments(query);

    // Get the posts with pagination
    const posts = await Post.find(query)
      .select("_id authorId content createdAt")
      .sort({ createdAt: -1 });

    for (const post of posts) {
      const postId = post._id;
      const content = post.content;
      if (!!content.trim()) {
        try {
          let categories = [];
          const { data: relatedCategories } = await axios.post(
            process.env.PYTHON_SERVER + "/search",
            {
              query: content,
            }
          );
          if (relatedCategories?.length) {
            const catesQuery = await Category.find(
              {
                name: {
                  $in: relatedCategories,
                },
              },
              { _id: 1 }
            );
            categories = catesQuery?.map(({ _id }) => _id);
            if (categories?.length) {
              await Post.updateOne(
                { _id: postId },
                { $set: { categories: categories } }
              );
            }
          }
        } catch (err) {
          console.log("error when get related categories: ", err);
        }
      }
    }

    return res.status(HTTPStatus.OK).json({
      total,
      posts,
    });
  } catch (err) {
    console.log("getPostsWithContent error:", err);
    res.status(HTTPStatus.SERVER_ERR).json({ error: err.message });
  }
};

export const assignRandomCategoriesToUsers = async (req, res) => {
  try {
    const { minCategories = 1, maxCategories = 4 } = req.query;

    // Convert to numbers
    const min = parseInt(minCategories as string);
    const max = parseInt(maxCategories as string);

    // Validate min and max
    if (isNaN(min) || isNaN(max) || min < 1 || max < min) {
      return res.status(HTTPStatus.BAD_REQUEST).json({
        error:
          "Invalid min or max categories. Min should be at least 1 and max should be >= min",
      });
    }

    // Get all categories
    const categories = await Category.find({}, { _id: 1 });
    if (!categories.length) {
      return res.status(HTTPStatus.NOT_FOUND).json({
        error: "No categories found. Please import categories first.",
      });
    }

    // Get all users
    const users = await User.find({});
    if (!users.length) {
      return res.status(HTTPStatus.NOT_FOUND).json({
        error: "No users found.",
      });
    }

    const categoryIds = categories.map((cat) => cat._id);
    const updateResults = [];

    // Assign random categories to each user
    for (const user of users) {
      // Generate random number of categories within the specified range
      const numCategories = Math.floor(Math.random() * (max - min + 1)) + min;

      // Shuffle the category IDs and take a slice of the required length
      const shuffled = [...categoryIds].sort(() => 0.5 - Math.random());
      const selectedCategories = shuffled.slice(0, numCategories);

      // Update the user
      const result = await User.updateOne(
        { _id: user._id },
        { $set: { catesCare: selectedCategories } }
      );

      updateResults.push({
        userId: user._id,
        username: user.username,
        numCategoriesAssigned: numCategories,
        updateResult: result,
      });
    }

    return res.status(HTTPStatus.OK).json({
      message: "Categories randomly assigned to users",
      totalUsers: users.length,
      updateResults,
    });
  } catch (err) {
    console.log("assignRandomCategoriesToUsers error:", err);
    res.status(HTTPStatus.SERVER_ERR).json({ error: err.message });
  }
};
