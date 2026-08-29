import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { REPORT_PATH } from "../../Breads-Shared/APIConfig.ts";
import { Constants } from "../../Breads-Shared/Constants/index.ts";
import asyncHandler from "../../helpers/asyncHandler.ts";
import {
  getReports,
  rejectReport,
  responseReport,
  sendReport,
} from "../controllers/report.controller.ts";
import protectRoute from "../middlewares/protectRoute.js";
import { requireRole } from "../middlewares/requireRole.js";
import { validate } from "../middlewares/validate.ts";
import {
  getReportsSchema,
  rejectReportSchema,
  responseReportSchema,
  sendReportSchema,
} from "../validators/report.validator.ts";

const router = express.Router();
// AD-4: blanket 50mb cho cả router, kể cả RESPONSE/REJECT không cần media — xem epic.md
router.use(express.json({ limit: "50mb" }));
// FR-5 (task 013): sanitize NoSQL operator + HPP.
router.use(mongoSanitize());
router.use(hpp());

router.get(
  REPORT_PATH.GET,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR),
  validate(getReportsSchema),
  asyncHandler(getReports),
);
router.post(
  REPORT_PATH.CREATE,
  protectRoute,
  validate(sendReportSchema),
  asyncHandler(sendReport),
);
// Task 014 (D-1): partial update theo id -> PATCH, id trong path.
router.patch(
  REPORT_PATH.RESPONSE,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR),
  validate(responseReportSchema),
  asyncHandler(responseReport),
);
router.patch(
  REPORT_PATH.REJECT,
  protectRoute,
  requireRole(Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR),
  validate(rejectReportSchema),
  asyncHandler(rejectReport),
);

export default router;
