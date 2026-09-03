import { Constants } from "../../Breads-Shared/Constants";
import {
  NotFoundError,
  BadRequestError,
  ErrorResponse,
} from "../../core/error.response";
import HTTPStatus from "../../utils/httpStatus.ts";
import { OK } from "../../core/success.response";
import { ObjectId } from "../../utils";
import Report from "../models/report.model";
import User from "../models/user.model";
import { sendMailService } from "../services/util";
import { uploadFileFromBase64 } from "../utils";
import { assertRole } from "../middlewares/requireRole.js";

export const sendReport = async (req, res) => {
  const { content, media } = req.body;
  const userId = String(req.user._id);
  const userInfo = await User.findOne(
    {
      _id: ObjectId(userId),
    },
    {
      _id: 0,
      email: 1,
    }
  );
  const userEmail = userInfo?.email;
  if (!userEmail) {
    throw new BadRequestError("Invalid user email");
  }
  let newMedia = [];
  if (media?.length > 0) {
    for (let fileInfo of media) {
      const mediaUrl = await uploadFileFromBase64({
        base64: fileInfo.url,
      });
      fileInfo.url = mediaUrl;
      newMedia.push(fileInfo);
    }
  }
  const newReport = new Report({
    userId: ObjectId(userId),
    content: content,
    media: newMedia,
  });
  await newReport.save();
  new OK({
    message: "Report sent successfully",
    metadata: {},
  }).send(res);
};

export const getReports = async (req, res) => {
  const { searchValue, page, limit } = req.query;
  assertRole(req.user, Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR);
  const pageNum = Number(page) || 1;
  const limitNum = Number(limit) || 10;
  const agg = [
    {
      $match: {
        status: Constants.REPORT_STATUS.PENDING,
      },
    },
    {
      $lookup: {
        from: "users",
        let: { searchId: { $toObjectId: "$userId" } },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ["$$searchId", "$_id"],
              },
            },
          },
          {
            $project: {
              _id: 1,
              username: 1,
              avatar: 1,
              name: 1,
              email: 1,
            },
          },
        ],
        as: "userReport",
      },
    },
    {
      $unwind: "$userReport",
    },
    ...(searchValue
      ? [
          {
            $match: {
              $or: [
                {
                  "userReport.username": {
                    $regex: searchValue,
                    $options: "i",
                  },
                },
                {
                  "userReport.name": {
                    $regex: searchValue,
                    $options: "i",
                  },
                },
              ],
            },
          },
        ]
      : []),
    {
      $sort: {
        createdAt: -1,
      },
    },
    {
      $facet: {
        data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
        totalCount: [{ $count: "count" }],
      },
    },
  ];
  const [result] = await Report.aggregate(agg);
  const data = result?.data ?? [];
  const totalCount = result?.totalCount?.[0]?.count ?? 0;
  new OK({
    message: "Reports fetched successfully",
    metadata: { data, totalCount },
  }).send(res);
};

export const getReportsByUser = async (req, res) => {
  const { id } = req.params;
  const reports = await Report.find({ userId: id })
    .select("content status createdAt")
    .sort({ createdAt: -1 });
  new OK({
    message: "Reports by user fetched successfully",
    metadata: reports,
  }).send(res);
};

export const responseReport = async (req, res) => {
  const { subject, html } = req.body;
  const { id: reportId } = req.params;
  if (!subject) {
    throw new BadRequestError("Invalid input");
  }
  assertRole(req.user, Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR);

  const report: any = await Report.findById(reportId, { userId: 1 }).lean();
  if (!report) {
    throw new NotFoundError("Report not found");
  }
  const reporter: any = await User.findById(report.userId, { email: 1 }).lean();
  if (!reporter?.email) {
    throw new BadRequestError("Reporter has no email");
  }

  const result = await sendMailService({
    from: undefined,
    to: reporter.email,
    subject,
    html,
  });
  if (!result) {
    throw new ErrorResponse("Failed to send email", HTTPStatus.SERVER_ERR);
  }
  await Report.updateOne(
    {
      _id: ObjectId(reportId),
    },
    {
      status: Constants.REPORT_STATUS.RESPONSED,
    }
  );
  new OK({
    message: "Report responded successfully",
    metadata: result,
  }).send(res);
};

export const rejectReport = async (req, res) => {
  const { id: reportId } = req.params;
  if (!reportId) {
    throw new BadRequestError("Invalid input");
  }
  assertRole(req.user, Constants.USER_ROLE.ADMIN, Constants.USER_ROLE.MODERATOR);
  await Report.updateOne(
    {
      _id: ObjectId(reportId),
    },
    {
      status: Constants.REPORT_STATUS.REJECT,
    }
  );
  new OK({
    message: "Report rejected successfully",
    metadata: {},
  }).send(res);
};
