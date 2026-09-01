// Run with Node's built-in test runner: `npm test`.
//
// Phạm vi: Task 018 — `responseReport` không được set `status: RESPONSED` khi gửi mail thất bại
// (xem `018.md`). `sendMailService` (`services/util.ts`) nuốt lỗi im lặng (catch không throw),
// nên bug gốc chỉ lộ ra qua GIÁ TRỊ TRẢ VỀ (`undefined` khi lỗi) — không qua exception.
// Task 022 (bổ sung, xem cuối file) — role-matrix (ADMIN/MODERATOR/USER/anonymous) cho
// `getReports`/`responseReport`/`rejectReport` + pagination boundary cho `getReports`, vì
// `report.route.test.ts` chỉ verify wiring/schema router, không exercise logic 3 hàm này.
//
// Vì sao mock ở tầng `nodemailer.createTransport` thay vì mock thẳng `sendMailService`:
// `sendMailService` là 1 named export dạng `export const fn = ...` của module ESM thật
// ("type": "module" trong package.json). Dưới `node --test` (không phải `tsx <file>` đơn lẻ),
// namespace object của module ESM là frozen — gán `mod.sendMailService = stub` ném
// `TypeError: Cannot assign to read only property` (đã verify thực nghiệm khi viết task này).
// `nodemailer` thì ngược lại: nó là package CJS, `import nodemailer from "nodemailer"` cho ra
// đúng object `module.exports` gốc (mutable) qua cơ chế CJS/ESM interop của Node — ghi đè
// `nodemailer.createTransport` an toàn và không đụng `services/util.ts` (AD-2, KHÔNG được sửa
// file đó). Nhờ vậy `responseReport` chạy qua `sendMailService` THẬT (đúng like pattern
// `withStubbedModels` ở `post.route.test.ts`: stub ở biên I/O ngoài cùng, không stub logic của
// chính mình), quan sát đúng hành vi truthy/falsy như prod.
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

const validBody = {
  from: "admin@breads.dev",
  to: "user@example.com",
  subject: "Về báo cáo của bạn",
  html: "<p>hi</p>",
  userId: ADMIN_USER_ID,
};

/** Stub `User.findOne` (role-check trong `responseReport`) — không cần Mongo thật. */
const withStubbedUserFindOne = async (
  role: number | undefined,
  fn: () => Promise<void>
) => {
  const original = (User as any).findOne;
  (User as any).findOne = async () => (role === undefined ? null : { role });
  try {
    await fn();
  } finally {
    (User as any).findOne = original;
  }
};

/** Stub `Report.updateOne`, đếm số lần gọi + ghi lại args — đây là assertion chính của AC:
 * "Report.updateOne KHÔNG được gọi khi gửi mail thất bại". */
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

/** Stub `nodemailer.createTransport` — xem giải thích ở đầu file lý do stub tại đây thay vì
 * thẳng `sendMailService`. `sendMailImpl` mô phỏng `transporter.sendMail`. */
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
  const req: any = { body: validBody, params: { id: REPORT_ID } };
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
  await withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      // `sendMailService` catch lỗi này và trả `undefined` — đúng bug gốc mô tả ở Context 018.md.
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

test("responseReport: sendMailService thành công -> Report.updateOne(status=RESPONSED), response 200", async () => {
  const fakeInfo = { messageId: "abc123" }; // giả lập `info` thật từ nodemailer, chỉ cần truthy
  await withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, async () => {
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

// ---------------------------------------------------------------------------
// Task 022 — role-matrix (ADMIN/MODERATOR/USER/anonymous) cho getReports/
// responseReport/rejectReport + pagination boundary cho getReports. `report.route.test.ts`
// (14 test hiện có) chỉ verify wiring/schema router, KHÔNG exercise logic của 3 hàm này —
// đây là gap task 022 lấp lại.
// ---------------------------------------------------------------------------

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

/** Stub `Report.aggregate` — trả về đúng shape `$facet` (`[{data, totalCount}]`), đồng thời
 * ghi lại pipeline truyền vào để assert giá trị `$skip`/`$limit` thật sự nhận được (boundary
 * check) — không cần Mongo thật, không re-implement logic skip/limit trong stub. */
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

/** Đọc giá trị `$skip`/`$limit` thật sự trong stage `$facet.data` của pipeline đã capture. */
const readFacetSkipLimit = (pipeline: any[]) => {
  const facetStage = pipeline.find((stage) => "$facet" in stage);
  const skipStage = facetStage.$facet.data.find((s: any) => "$skip" in s);
  const limitStage = facetStage.$facet.data.find((s: any) => "$limit" in s);
  return { skip: skipStage.$skip, limit: limitStage.$limit };
};

const makeGetReportsReqRes = (query: Record<string, any>) => ({
  req: { query },
  res: makeRes(),
});

const makeRejectReportReqRes = (userId: string | undefined, reportId: string) => ({
  req: { body: { userId }, params: { id: reportId } },
  res: makeRes(),
});

/* ------------------------------- getReports: role-matrix ------------------------------- */

test("getReports: ADMIN -> 200, không bị chặn quyền", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportAggregate({ data: [], totalCountValue: 0 }, async () => {
      const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
      await getReports(req, res);
      assert.equal(res.statusCode, 200);
    });
  });
});

test("getReports: MODERATOR -> 200, không bị chặn quyền (giống ADMIN)", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.MODERATOR, async () => {
    await withStubbedReportAggregate({ data: [], totalCountValue: 0 }, async () => {
      const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
      await getReports(req, res);
      assert.equal(res.statusCode, 200);
    });
  });
});

test("getReports: USER thường -> ForbiddenError (403), không gọi Report.aggregate", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.USER, async () => {
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
  await withStubbedUserFindOne(undefined, async () => {
    const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
    await assert.rejects(
      () => getReports(req, res),
      (err: any) => err instanceof ForbiddenError
    );
  });
});

/* ---------------------------- getReports: pagination boundary -------------------------- */

test("getReports: page=3&limit=5 -> $skip=10/$limit=5 đúng, data/totalCount pass-through đúng", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, async () => {
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
  await withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, async () => {
    await withStubbedReportAggregate({ data: [], totalCountValue: 0 }, async (pipelines) => {
      const { req, res } = makeGetReportsReqRes({ userId: ADMIN_USER_ID });
      await getReports(req, res);

      const { skip, limit } = readFacetSkipLimit(pipelines[0]);
      assert.equal(skip, 0);
      assert.equal(limit, 10);
    });
  });
});

/* ----------------------------- responseReport: role-matrix ----------------------------- */
// ADMIN đã được cover ở 2 test mail-fail/mail-success phía trên (dùng
// `withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, ...)`) — chỉ bổ sung MODERATOR/USER/anonymous.

test("responseReport: MODERATOR -> thành công giống ADMIN (Report.updateOne được gọi, response 200)", async () => {
  const fakeInfo = { messageId: "moderator-ok" };
  await withStubbedUserFindOne(Constants.USER_ROLE.MODERATOR, async () => {
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

test("responseReport: USER thường -> ForbiddenError, Report.updateOne KHÔNG được gọi", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.USER, async () => {
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
  await withStubbedUserFindOne(undefined, async () => {
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

/* ------------------------------- rejectReport: role-matrix ----------------------------- */

test("rejectReport: ADMIN -> Report.updateOne(status=REJECT) được gọi, response 200", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.ADMIN, async () => {
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
  await withStubbedUserFindOne(Constants.USER_ROLE.MODERATOR, async () => {
    await withStubbedReportUpdateOne(async (calls) => {
      const { req, res } = makeRejectReportReqRes(ADMIN_USER_ID, REPORT_ID);
      await rejectReport(req, res);
      assert.equal(calls.length, 1);
      assert.equal(res.statusCode, 200);
    });
  });
});

test("rejectReport: USER thường -> ForbiddenError, Report.updateOne KHÔNG được gọi", async () => {
  await withStubbedUserFindOne(Constants.USER_ROLE.USER, async () => {
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
  await withStubbedUserFindOne(undefined, async () => {
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

/* --------------------------- Regression: report.route.test.ts -------------------------- */
// Không cần code — chỉ chạy `npm test` (bao gồm `report.route.test.ts`, 14 test wiring/schema
// cũ) để xác nhận 0 regression sau khi thêm các test ở trên. Xem Verification Checklist ở
// `022.md`/issue #22.
