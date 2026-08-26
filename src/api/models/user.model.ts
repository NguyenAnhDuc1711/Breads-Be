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

userSchema.index({ lastActiveAt: -1 });
// ESR: phục vụ query lọc `status` (equality) trước range trên `followersCount` (vd. sitemap FR-3
// `{status:ACTIVE, followersCount:$gte}`).
userSchema.index({ status: 1, followersCount: 1 });
// SITEMAP_MAX_RECORDS (top-N ưu tiên, fix sau epic seo-sitemap-schema): sitemap-eligible giờ sort
// `{followersCount:-1, _id:-1}` (top-N ưu tiên + tie-break theo mới nhất) thay vì `{_id:1}` — index
// TRÊN đây (`{status,followersCount:1}`, không có `_id`) KHÔNG đủ để tránh in-memory sort: đo thật
// trên dataset dev (~874K user matching) cho thấy Mongo phải quét + sort trong RAM toàn bộ tập kết
// quả, ~5.6 giây/trang. Index dưới đây khớp CHÍNH XÁC chiều sort của query mới -> IXSCAN thuần,
// không sort-in-memory (đối chứng: post KHÔNG cần index mới vì hệ feed ranking đã có sẵn
// `{engagementScore:-1,_id:-1}` đúng hình dạng cần, xem `post.model.ts`).
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

const User = mongoose.model("User", userSchema);

export default User;
