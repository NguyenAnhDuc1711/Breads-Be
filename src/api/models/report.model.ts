import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;
const reportSchema = mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
    },
    content: {
      type: String,
      default: "",
    },
    media: {
      type: Array,
      required: false,
    },
    status: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

const Report = mongoose.model("Report", reportSchema);

export default Report;
