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

const router = express.Router();

router.get(REPORT_PATH.GET, asyncHandler(getReports));
router.post(REPORT_PATH.CREATE, protectRoute, asyncHandler(sendReport));
router.post(REPORT_PATH.RESPONSE, asyncHandler(responseReport));
router.post(REPORT_PATH.REJECT, asyncHandler(rejectReport));

export default router;
