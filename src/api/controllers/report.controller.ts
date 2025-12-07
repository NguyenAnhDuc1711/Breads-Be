import { Constants } from "../../Breads-Shared/Constants";
import {
  AuthFailureError,
  BadRequestError,
  ForbiddenError,
} from "../../core/error.response";
import { OK } from "../../core/success.response";
import { ObjectId } from "../../utils";
import Report from "../models/report.model";
import User from "../models/user.model";
import { sendMailService } from "../services/util";
import { uploadFileFromBase64 } from "../utils";

export const sendReport = async (req, res) => {
  const { userId, content, media } = req.body;
  if (!userId) {
    throw new AuthFailureError("Unauthorized");
  }
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
  const { userId, searchValue, page, limit } = req.query;
  if (!userId) {
    throw new BadRequestError("Empty userId");
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo?.role === Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    throw new ForbiddenError();
  }
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
    {
      $sort: {
        createdAt: -1,
      },
    },
  ];
  const data = await Report.aggregate(agg);
  new OK({
    message: "Reports fetched successfully",
    metadata: data,
  }).send(res);
};

export const responseReport = async (req, res) => {
  const { from, to, subject, html, userId, reportId } = req.body;
  if (!userId || !from || !to || !subject) {
    throw new BadRequestError("Invalid input");
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo?.role == Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    throw new ForbiddenError();
  }
  const result = await sendMailService({
    from,
    to,
    subject,
    html,
  });
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
  const { userId, reportId } = req.body;
  if (!userId || !reportId) {
    throw new BadRequestError("Invalid input");
  }
  const userInfo = await User.findOne({
    _id: ObjectId(userId),
  });
  const isAdmin = userInfo?.role == Constants.USER_ROLE.ADMIN;
  if (!isAdmin) {
    throw new ForbiddenError();
  }
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
