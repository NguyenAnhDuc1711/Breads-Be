import assert from "node:assert/strict";
import { test } from "node:test";
import nodemailer from "nodemailer";
import { Constants } from "../../Breads-Shared/Constants";
import { ErrorResponse, ForbiddenError } from "../../core/error.response";
import HTTPStatus from "../../utils/httpStatus.ts";
import { getReports, rejectReport, responseReport } from "./report.controller.ts";
import Report from "../models/report.model";
import User from "../models/user.model";

const ADMIN_USER_ID = "652f1b2c3d4e5f6071829304";
const REPORT_ID = "652f1b2c3d4e5f6071829305";

const REPORTER_EMAIL = "reporter@example.com";

const validBody = {
  from: "attacker@evil.test",
  to: "victim@evil.test",
  subject: "Về báo cáo của bạn",
  html: "<p>hi</p>",
  userId: ADMIN_USER_ID,
};

const withStubbedReportLookup = async (fn: () => Promise<void>) => {
  const origReportFind = (Report as any).findById;
  const origUserFind = (User as any).findById;
  (Report as any).findById = () => ({
    lean: async () => ({ _id: REPORT_ID, userId: ADMIN_USER_ID }),
  });
  (User as any).findById = () => ({
    lean: async () => ({ _id: ADMIN_USER_ID, email: REPORTER_EMAIL }),
  });
  try {
    await fn();
  } finally {
    (Report as any).findById = origReportFind;
    (User as any).findById = origUserFind;
  }
};

let callerRole: number | undefined;

const withCallerRole = async (role: number | undefined, fn: () => Promise<void>) => {
  const prev = callerRole;
  callerRole = role;
  try {
    await fn();
  } finally {
    callerRole = prev;
  }
};

const reqUser = () =>
  callerRole === undefined ? undefined : { _id: ADMIN_USER_ID, role: callerRole };

const withStubbedReportUpdateOne = async (
  fn: (calls: any[][]) => Promise<void>
) => {
  const original = (Report as any).updateOne;
  const calls: any[][] = [];
  (Report as any).updateOne = async (...args: any[]) => {
    calls.push(args);
    return { acknowledged: true };
  };
  try {
    await fn(calls);
  } finally {
    (Report as any).updateOne = original;
  }
};

const withStubbedTransport = async (
  sendMailImpl: (...args: any[]) => Promise<any>,
  fn: () => Promise<void>
) => {
  const original = (nodemailer as any).createTransport;
  (nodemailer as any).createTransport = () => ({ sendMail: sendMailImpl });
  try {
    await fn();
  } finally {
    (nodemailer as any).createTransport = original;
  }
};

const makeReqRes = () => {
  const req: any = { body: validBody, params: { id: REPORT_ID }, user: reqUser() };
  const res: any = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return { req, res };
};

test("responseReport: sendMailService thất bại (sendMail throw -> undefined) -> throw lỗi, KHÔNG update status", async () => {
  await withStubbedReportLookup(async () => {
  await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      await withStubbedTransport(
        async () => {
          throw new Error("SMTP down (SEND_MAIL_PASS sai/quota)");
        },
        async () => {
          const { req, res } = makeReqRes();

          await assert.rejects(
            () => responseReport(req, res),
            (err: any) => {
              assert.ok(err instanceof ErrorResponse);
              assert.equal(err.message, "Failed to send email");
              assert.equal(err.statusCode, HTTPStatus.SERVER_ERR);
              return true;
            }
          );

          assert.equal(
            calls.length,
            0,
            "Report.updateOne KHÔNG được gọi khi gửi mail thất bại — status DB không đổi"
          );
        }
      );
    });
  });
  });
});

test("responseReport: sendMailService thành công -> Report.updateOne(status=RESPONSED), response 200", async () => {
  const fakeInfo = { messageId: "abc123" };
  await withStubbedReportLookup(async () => {
  await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      await withStubbedTransport(
        async () => fakeInfo,
        async () => {
          const { req, res } = makeReqRes();

          await responseReport(req, res);

          assert.equal(calls.length, 1, "Report.updateOne phải được gọi đúng 1 lần");
          const [filter, update] = calls[0];
          assert.equal(String(filter._id), REPORT_ID);
          assert.deepEqual(update, { status: Constants.REPORT_STATUS.RESPONSED });

          assert.equal(res.statusCode, 200);
          assert.deepEqual(res.body.metadata, fakeInfo);
        }
      );
    });
  });
  });
});

const makeRes = () => {
  const res: any = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const withStubbedReportAggregate = async (
  result: { data: any[]; totalCountValue: number },
  fn: (pipelines: any[]) => Promise<void>
) => {
  const original = (Report as any).aggregate;
  const pipelines: any[] = [];
  (Report as any).aggregate = async (pipeline: any) => {
    pipelines.push(pipeline);
    return [
      {
        data: result.data,
        totalCount: [{ count: result.totalCountValue }],
      },
    ];
  };
  try {
    await fn(pipelines);
  } finally {
    (Report as any).aggregate = original;
  }
};

const readFacetSkipLimit = (pipeline: any[]) => {
  const facetStage = pipeline.find((stage) => "$facet" in stage);
  const skipStage = facetStage.$facet.data.find((s: any) => "$skip" in s);
  const limitStage = facetStage.$facet.data.find((s: any) => "$limit" in s);
  return { skip: skipStage.$skip, limit: limitStage.$limit };
};

const makeGetReportsReqRes = (query: Record<string, any>) => ({
  req: { query, user: reqUser() },
  res: makeRes(),
});

const makeRejectReportReqRes = (userId: string | undefined, reportId: string) => ({
  req: { body: { userId }, params: { id: reportId }, user: reqUser() },
  res: makeRes(),
});

test("#1: responseReport gửi tới email của NGƯỜI BÁO CÁO, bỏ qua `to` client gửi", async () => {
  let sentOptions: any = null;
  await withStubbedReportLookup(async () => {
    await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
      await withStubbedReportUpdateOne(async () => {
        await withStubbedTransport(
          async (options: any) => {
            sentOptions = options;
            return { messageId: "ok" };
          },
          async () => {
            const { req, res } = makeReqRes();
            await responseReport(req, res);
            assert.equal(res.statusCode, 200);
          }
        );
      });
    });
  });

  assert.ok(sentOptions, "sendMail phải được gọi");
  assert.equal(
    sentOptions.to,
    REPORTER_EMAIL,
    "người nhận phải suy ra từ report, KHÔNG phải `req.body.to`"
  );
  assert.notEqual(sentOptions.to, validBody.to, "địa chỉ client gửi phải bị bỏ qua");
  assert.notEqual(
    sentOptions.from,
    validBody.from,
    "`from` client gửi phải bị bỏ qua (sendMailService tự dùng SEND_MAIL_USER)"
  );
});

test("#1: responseReport với report không tồn tại -> lỗi, KHÔNG gửi mail", async () => {
  const origReportFind = (Report as any).findById;
  (Report as any).findById = () => ({ lean: async () => null });
  let mailSent = false;
  try {
    await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
      await withStubbedTransport(
        async () => {
          mailSent = true;
          return { messageId: "should-not-happen" };
        },
        async () => {
          const { req, res } = makeReqRes();
          await assert.rejects(() => responseReport(req, res));
          assert.equal(mailSent, false, "không được gửi mail khi report không tồn tại");
        }
      );
    });
  } finally {
    (Report as any).findById = origReportFind;
  }
});

test("getReports: ADMIN -> 200, không bị chặn quyền", async () => {
  await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportAggregate({ data: [], totalCountValue: 0 }, async () => {
      const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
      await getReports(req, res);
      assert.equal(res.statusCode, 200);
    });
  });
});

test("getReports: MODERATOR -> 200, không bị chặn quyền (giống ADMIN)", async () => {
  await withCallerRole(Constants.USER_ROLE.MODERATOR, async () => {
    await withStubbedReportAggregate({ data: [], totalCountValue: 0 }, async () => {
      const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
      await getReports(req, res);
      assert.equal(res.statusCode, 200);
    });
  });
});

test("getReports: USER thường -> ForbiddenError (403), không gọi Report.aggregate", async () => {
  await withCallerRole(Constants.USER_ROLE.USER, async () => {
    const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
    await assert.rejects(
      () => getReports(req, res),
      (err: any) => {
        assert.ok(err instanceof ForbiddenError);
        assert.equal(err.statusCode, HTTPStatus.FORBIDDEN);
        return true;
      }
    );
  });
});

test("getReports: user không tồn tại (anonymous) -> ForbiddenError (403)", async () => {
  await withCallerRole(undefined, async () => {
    const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
    await assert.rejects(
      () => getReports(req, res),
      (err: any) => err instanceof ForbiddenError
    );
  });
});

test("getReports: page=3&limit=5 -> $skip=10/$limit=5 đúng, data/totalCount pass-through đúng", async () => {
  await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
    const fakeData = Array.from({ length: 5 }, (_, i) => ({ _id: `r${i}` }));
    await withStubbedReportAggregate(
      { data: fakeData, totalCountValue: 12 },
      async (pipelines) => {
        const { req, res } = makeGetReportsReqRes({
          userId: ADMIN_USER_ID,
          page: "3",
          limit: "5",
        });
        await getReports(req, res);

        const { skip, limit } = readFacetSkipLimit(pipelines[0]);
        assert.equal(skip, 10, "(pageNum-1)*limitNum = (3-1)*5 = 10");
        assert.equal(limit, 5);

        assert.equal(res.body.metadata.data.length, 5);
        assert.equal(res.body.metadata.totalCount, 12, "không phải 5 (data.length)");
      }
    );
  });
});

test("getReports: thiếu page/limit -> mặc định pageNum=1, limitNum=10 ($skip=0/$limit=10)", async () => {
  await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportAggregate({ data: [], totalCountValue: 0 }, async (pipelines) => {
      const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
      await getReports(req, res);

      const { skip, limit } = readFacetSkipLimit(pipelines[0]);
      assert.equal(skip, 0);
      assert.equal(limit, 10);
    });
  });
});

test("responseReport: MODERATOR -> thành công giống ADMIN (Report.updateOne được gọi, response 200)", async () => {
  const fakeInfo = { messageId: "moderator-ok" };
  await withStubbedReportLookup(async () => {
  await withCallerRole(Constants.USER_ROLE.MODERATOR, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      await withStubbedTransport(
        async () => fakeInfo,
        async () => {
          const { req, res } = makeReqRes();
          await responseReport(req, res);
          assert.equal(calls.length, 1);
          assert.equal(res.statusCode, 200);
        }
      );
    });
  });
  });
});

test("responseReport: USER thường -> ForbiddenError, Report.updateOne KHÔNG được gọi", async () => {
  await withCallerRole(Constants.USER_ROLE.USER, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeReqRes();
      await assert.rejects(
        () => responseReport(req, res),
        (err: any) => err instanceof ForbiddenError
      );
      assert.equal(calls.length, 0);
    });
  });
});

test("responseReport: user không tồn tại (anonymous) -> ForbiddenError, Report.updateOne KHÔNG được gọi", async () => {
  await withCallerRole(undefined, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeReqRes();
      await assert.rejects(
        () => responseReport(req, res),
        (err: any) => err instanceof ForbiddenError
      );
      assert.equal(calls.length, 0);
    });
  });
});

test("rejectReport: ADMIN -> Report.updateOne(status=REJECT) được gọi, response 200", async () => {
  await withCallerRole(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeRejectReportReqRes(ADMIN_USER_ID, REPORT_ID);
      await rejectReport(req, res);
      assert.equal(calls.length, 1);
      const [filter, update] = calls[0];
      assert.equal(String(filter._id), REPORT_ID);
      assert.deepEqual(update, { status: Constants.REPORT_STATUS.REJECT });
      assert.equal(res.statusCode, 200);
    });
  });
});

test("rejectReport: MODERATOR -> thành công giống ADMIN", async () => {
  await withCallerRole(Constants.USER_ROLE.MODERATOR, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeRejectReportReqRes(ADMIN_USER_ID, REPORT_ID);
      await rejectReport(req, res);
      assert.equal(calls.length, 1);
      assert.equal(res.statusCode, 200);
    });
  });
});

test("rejectReport: USER thường -> ForbiddenError, Report.updateOne KHÔNG được gọi", async () => {
  await withCallerRole(Constants.USER_ROLE.USER, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeRejectReportReqRes(ADMIN_USER_ID, REPORT_ID);
      await assert.rejects(
        () => rejectReport(req, res),
        (err: any) => err instanceof ForbiddenError
      );
      assert.equal(calls.length, 0);
    });
  });
});

test("rejectReport: user không tồn tại (anonymous) -> ForbiddenError, Report.updateOne KHÔNG được gọi", async () => {
  await withCallerRole(undefined, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeRejectReportReqRes(ADMIN_USER_ID, REPORT_ID);
      await assert.rejects(
        () => rejectReport(req, res),
        (err: any) => err instanceof ForbiddenError
      );
      assert.equal(calls.length, 0);
    });
  });
});
