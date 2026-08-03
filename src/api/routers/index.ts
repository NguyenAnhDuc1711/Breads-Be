import express from "express";
import { Route } from "../../Breads-Shared/APIConfig.js";
import analysticsRouter from "./analytics.route.js";
import collectionRouter from "./collection.route.js";
import messageRouter from "./message.route.js";
import notificationRouter from "./notification.route.js";
import postRouter from "./post.route.js";
import reportRouter from "./report.route.js";
import userRouter from "./user.route.js";
import utilRouter from "./util.route.js";

const router = express.Router();

router.use(Route.USER, userRouter);
router.use(Route.POST, postRouter);
router.use(Route.COLLECTION, collectionRouter);
router.use(Route.UTIL, utilRouter);
router.use(Route.MESSAGE, messageRouter);
router.use(Route.NOTIFICATION, notificationRouter);
router.use(Route.ANALYTICS, analysticsRouter);
router.use(Route.REPORT, reportRouter);

export default router;
