import mongoose from "mongoose";
import { Constants } from "../../Breads-Shared/Constants/index.js";

const ObjectId = mongoose.Schema.Types.ObjectId;
const userStatus = Object.values(Constants.USER_STATUS);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      minLength: 6,
      required: true,
    },
    avatar: {
      type: String,
      default:
        "https://as2.ftcdn.net/v2/jpg/04/10/43/77/1000_F_410437733_hdq4Q3QOH9uwh0mcqAhRFzOKfrCR24Ta.jpg",
    },
    bio: {
      type: String,
      default: "",
    },
    role: {
      type: Number,
      default: 1,
    },
    links: [
      {
        type: String,
        required: false,
      },
    ],
    hasNewNotify: {
      type: Boolean,
      default: false,
    },
    hasNewMsg: {
      type: Boolean,
      default: false,
    },
    resetPWCode: {
      type: String,
      required: false,
    },
    status: {
      type: Number,
      enum: userStatus,
      default: Constants.USER_STATUS.ACTIVE,
    },
    statusReason: {
      type: String,
      default: "",
    },
    catesCare: [
      {
        type: ObjectId,
        ref: "Categories",
        required: false,
      },
    ],
    followersCount: {
      type: Number,
      default: 0,
    },
    followingCount: {
      type: Number,
      default: 0,
    },
    lastActiveAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Follow-suggestion cron (`followSuggestion/cron.ts`) phân trang theo keyset
// `sort({lastActiveAt:-1, _id:-1})` để chỉ enqueue user active trong `activeWindowDays` gần nhất.
userSchema.index({ lastActiveAt: -1, _id: -1 });
// ESR (Equality-Sort-Range): phục vụ query lọc `status` (equality) trước sort/range trên
// `followersCount` (vd. sitemap FR-3 `{status:ACTIVE, followersCount:$gte}`, sort
// `{followersCount:-1, _id:-1}` top-N ưu tiên + tie-break theo mới nhất) -> IXSCAN thuần,
// không sort-in-memory.
userSchema.index({ status: 1, followersCount: -1, _id: -1 });
// Task 011 (epic follow-suggestions): `getUserToFollows`' fallback aggregation
// (`user.controller.ts`) sorts by a per-request computed `score` field that can't be indexed
// directly (it depends on the viewer's own `catesCare`, recomputed on every request). This
// standalone index backs the pipeline's `$sort: {followersCount: -1}` pre-stage — `followersCount`
// is `score`'s dominant, unbounded term — so the fallback can bound its candidate pool via an
// indexed sort instead of scanning + in-memory-sorting the whole collection (the original root
// cause). Not covered by `{status:1, followersCount:-1, _id:-1}` above since that query has no
// `status` filter.
userSchema.index({ followersCount: -1 });
// ESR: Breads-Admin Users tab gộp `role` (equality) và `createdAt` (range, DateRangePicker) vào
// cùng 1 `$match` khi cả 2 filter được chọn cùng lúc — trước đây cả 2 field đều không có index,
// COLLSCAN toàn bộ collection. Compound này cũng phục vụ được filter role đứng riêng (dùng làm
// prefix); filter date đứng riêng (không kèm role) vẫn COLLSCAN — chấp nhận đánh đổi vì kết hợp
// role+date phổ biến hơn trong thao tác thực tế của admin.
userSchema.index({ role: 1, createdAt: 1 });

const User = mongoose.model("User", userSchema);

export default User;
