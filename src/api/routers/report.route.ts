import express from "express";
import { REPORT_PATH } from "../../Breads-Shared/APIConfig";
import asyncHandler from "../../helpers/asyncHandler.ts";
import {
  getReports,
  rejectReport,
  responseReport,
  sendReport,
} from "../controllers/report.controller.ts";
import protectRoute from "../middlewares/protectRoute.js";
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

router.get(REPORT_PATH.GET, validate(getReportsSchema), asyncHandler(getReports));
router.post(
  REPORT_PATH.CREATE,
  protectRoute,
  validate(sendReportSchema),
  asyncHandler(sendReport)
);
router.post(
  REPORT_PATH.RESPONSE,
  validate(responseReportSchema),
  asyncHandler(responseReport)
);
router.post(
  REPORT_PATH.REJECT,
  validate(rejectReportSchema),
  asyncHandler(rejectReport)
);

export default router;
