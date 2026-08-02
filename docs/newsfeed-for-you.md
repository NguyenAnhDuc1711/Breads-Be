# Cơ chế truy vấn bài viết mặc định (Newsfeed "For You")

Tài liệu mô tả nghiệp vụ cho luồng lấy bài viết mặc định hiển thị cho người dùng khi không áp dụng bộ lọc cụ thể nào (không phải tab Following, Saved, Liked, bài của một user...).

> Vị trí code liên quan: `getForYouPostsId` trong `src/api/services/post.js`, được gọi từ `getPostsIdByFilter` (nhánh `default`) và `getPosts` trong `src/api/controllers/post.controller.ts`.

## 1. Điều kiện đầu vào

- Hệ thống lấy hồ sơ người dùng đang đăng nhập, trong đó có danh sách **chủ đề mà người dùng quan tâm** (categories care).

## 2. Loại trừ những bài không phù hợp

- Không hiển thị các bài viết là **bình luận (reply)** — chỉ bài viết gốc hoặc bài repost/quote mới được đưa vào newsfeed.
- Không hiển thị **bài viết do chính người dùng đó đăng** — newsfeed "For You" chỉ gợi ý nội dung từ người khác.
- _Lưu ý:_ cơ chế này hiện **không lọc theo trạng thái bài viết** (ví dụ bài đang chờ duyệt/pending, bị ẩn...) như các luồng khác — mọi bài viết còn lại (miễn không phải reply, không phải của chính mình) đều được đưa vào tính điểm.

## 3. Tính điểm mức độ phù hợp (score) cho từng bài viết

Mỗi bài viết được chấm điểm dựa trên các yếu tố sau, cộng dồn lại:

| Yếu tố                                               | Trọng số        | Ý nghĩa kinh doanh                             |
| ---------------------------------------------------- | --------------- | ---------------------------------------------- |
| Số chủ đề của bài viết trùng với sở thích người dùng | ×15             | Ưu tiên cao nhất — nội dung đúng gu người dùng |
| Số lượt thích (like)                                 | ×3              | Bài càng được nhiều người thích càng nổi bật   |
| Số lượt phản hồi/bình luận                           | ×3              | Bài đang có tương tác/thảo luận sôi nổi        |
| Số lượng media (ảnh/video) đính kèm                  | ×2              | Ưu tiên nhẹ cho nội dung trực quan             |
| Có khảo sát (survey)                                 | +1 mỗi lựa chọn | Ưu tiên nhẹ cho bài có khảo sát                |

→ Mức độ **phù hợp với sở thích cá nhân** là yếu tố quyết định lớn nhất, sau đó mới đến độ **phổ biến/tương tác** của bài viết.

## 4. Sắp xếp và phân trang

- Bài viết có điểm số cao nhất được xếp lên đầu.
- Áp dụng phân trang: bỏ qua số bài đã hiển thị ở các trang trước, mỗi trang mặc định lấy **20 bài viết**.

## 5. Trả kết quả

- Từ danh sách ID bài viết theo thứ tự trên, hệ thống truy vấn tiếp để lấy **đầy đủ chi tiết** từng bài (thông tin tác giả, media, khảo sát, link đính kèm, bài gốc nếu là repost/quote...) rồi trả về cho client hiển thị.
