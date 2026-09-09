import UserModel from "../models/user.model.js";

/**
 * Lý do duy nhất khiến một hồ sơ Google hợp lệ vẫn bị từ chối ở bước phân giải danh tính:
 * email trỏ tới tài khoản đã gắn một `googleId` KHÁC (tổ hợp 4).
 */
export const GOOGLE_IDENTITY_CONFLICT_REASON =
  "email_linked_to_other_google_account";

/**
 * Union thay vì `user | null`: `null` không phân biệt được "chưa có tài khoản" (phải tạo)
 * với "bị từ chối" (không được tạo, không được đăng nhập). Union buộc chỗ gọi rẽ đủ bốn nhánh.
 */
export type GoogleIdentityResult =
  | { action: "create" }
  | { action: "link"; user: any }
  | { action: "login"; user: any }
  | { action: "reject"; reason: string };

export type GoogleIdentityQuery = {
  sub: string;
  email: string;
};

/**
 * Phân giải hồ sơ Google đã xác thực về một trong bốn trạng thái.
 *
 * Thứ tự tra cứu: `googleId` TRƯỚC, `email` SAU. `googleId` (`payload.sub`) là định danh bền
 * của Google, không đổi kể cả khi người dùng đổi email; email thì đổi được. Tra email trước
 * sẽ khiến người đổi email Google bị coi là người lạ và bị tạo tài khoản trùng.
 *
 * `userModel` được tiêm để test hàm này thuần tuý, không cần Mongo.
 */
export const resolveGoogleIdentity = async (
  { sub, email }: GoogleIdentityQuery,
  userModel: any = UserModel,
): Promise<GoogleIdentityResult> => {
  const byGoogleId = await userModel.findOne({ googleId: sub });
  if (byGoogleId) {
    // DỪNG TẠI ĐÂY. Không tra email nữa: kết quả tra email phải bị bỏ qua hoàn toàn (FR-7),
    // và email lưu trong hệ thống không được ghi đè bằng email mới từ Google.
    return { action: "login", user: byGoogleId };
  }

  const byEmail = await userModel.findOne({ email });
  if (!byEmail) {
    return { action: "create" };
  }

  if (!byEmail.googleId) {
    return { action: "link", user: byEmail };
  }

  // byEmail.googleId tồn tại và KHÁC sub (nếu bằng thì đã khớp ở lượt tra đầu tiên).
  // Ghi đè ở đây = cho phép người kiểm soát một email chiếm tài khoản của danh tính Google khác.
  return { action: "reject", reason: GOOGLE_IDENTITY_CONFLICT_REASON };
};
