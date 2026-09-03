import { AuthFailureError } from "../../core/error.response.ts";
import { OK } from "../../core/success.response.ts";
import { signBatch } from "../services/cloudinarySign.ts";

export const signUpload = async (req, res) => {
  const authUserId = req.user?._id?.toString();
  if (!authUserId) {
    throw new AuthFailureError("Unauthorized");
  }

  const { entityType, count, recipientId, items } = req.body;

  const context =
    entityType === "message"
      ? { senderId: authUserId, recipientId }
      : { authorId: authUserId };

  const signatures = signBatch({ entityType, count, context, items });

  new OK({
    message: "Signed upload params created",
    metadata: { signatures },
  }).send(res);
};
