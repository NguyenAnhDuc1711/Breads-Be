import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

const linkSchema = new mongoose.Schema(
  {
    //id of message
    targetId: {
      type: ObjectId,
      required: false,
    },
    url: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: "",
    },
    image: {
      type: String,
      default: "",
    },
    title: {
      type: String,
      default: "",
      required: true,
    },
  },
  { timestamps: true }
);

const Link = mongoose.model("Link", linkSchema);

export default Link;
