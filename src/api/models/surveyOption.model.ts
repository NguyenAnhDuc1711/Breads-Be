import mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;
const surveyOptionShema = mongoose.Schema({
  placeholder: {
    type: String,
  },
  value: {
    type: String,
    required: true,
  },
  usersId: [
    {
      type: ObjectId,
      ref: "User",
    },
  ],
});

const SurveyOption = mongoose.model("SurveyOption", surveyOptionShema);

export default SurveyOption;
