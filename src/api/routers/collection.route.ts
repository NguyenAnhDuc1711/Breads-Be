import express, { Router } from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import {
  addPostToCollection,
  getUserCollection,
  removePostFromCollection,
} from "../controllers/collection.controller.js";
import protectRoute from "../middlewares/protectRoute.js";
import { requireSelfOnParam } from "../middlewares/requireRole.js";
import { COLLECTION_PATH } from "../../Breads-Shared/APIConfig.js";
import asyncHandler from "../../helpers/asyncHandler.ts";
import { validate } from "../middlewares/validate.ts";
import {
  addPostToCollectionSchema,
  getUserCollectionSchema,
  removePostFromCollectionSchema,
} from "../validators/collection.validator.ts";

const router = Router();
// FR-2 (task 010): chỉ nhận id/paging, không có field lớn -> 1mb.
router.use(express.json({ limit: "1mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());
const { ADD, REMOVE } = COLLECTION_PATH;

// Bước 4 (access-control-hardening): dòng `import protectRoute` phía trên TỪNG BỊ COMMENT, nên cả
// 3 route đọc/ghi collection của một userId BẤT KỲ lấy từ path — không cần đăng nhập (probe V3a/V3b
// xác nhận đọc và xoá được collection người khác).
//
// Dùng `requireSelfOnParam("userId")` KHÔNG kèm role nào (self-only, không có cửa admin): "bài đã
// lưu" là dữ liệu riêng tư, không có nghiệp vụ nào cần admin đọc. Guard này còn giữ cho `:userId`
// trong URL nói ĐÚNG SỰ THẬT — thay vì để nó thành tham số trang trí mà controller âm thầm bỏ qua,
// một cái bẫy để người sửa sau tưởng nó có tác dụng và "khôi phục" lại đúng lỗ hổng cũ.
router.get(
  "/:userId",
  protectRoute,
  requireSelfOnParam("userId"),
  validate(getUserCollectionSchema),
  asyncHandler(getUserCollection)
);
router.patch(
  ADD,
  protectRoute,
  requireSelfOnParam("userId"),
  validate(addPostToCollectionSchema),
  asyncHandler(addPostToCollection)
);
// Task 013 (D-1): remove là xoá 1 relationship (item khỏi collection) -> DELETE, không phải PATCH.
router.delete(
  REMOVE,
  protectRoute,
  requireSelfOnParam("userId"),
  validate(removePostFromCollectionSchema),
  asyncHandler(removePostFromCollection)
);

export default router;
