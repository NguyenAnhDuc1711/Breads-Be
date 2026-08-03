// import drive from "../../auth/driveAuth.js";
// import fs from "fs";
// import mime from "mime-types";

// // Function to search for a folder by name
// const findOrCreateUserFolder = async (userId) => {
//   try {
//     // Search for the folder by name
//     const response = await drive.files.list({
//       q: `name='${userId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
//       spaces: "drive",
//       fields: "files(id, name)",
//     });

//     if (response.data.files.length > 0) {
//       console.log(`Folder for user ${userId} already exists.`);
//       return response.data.files[0].id; // Return the existing folder ID
//     }

//     // Create a new folder if it doesn't exist
//     const folderMetadata = {
//       name: userId,
//       mimeType: "application/vnd.google-apps.folder",
//       parents: ["root"], // Optional: place under a specific parent folder
//     };

//     const folder = await drive.files.create({
//       resource: folderMetadata,
//       fields: "id",
//     });

//     console.log(
//       `New folder created for user ${userId}. Folder ID: ${folder.data.id}`
//     );
//     return folder.data.id; // Return the new folder ID
//   } catch (error) {
//     console.error("Error finding or creating folder:", error.message);
//   }
// };

// export const uploadFileFromBase64ToDrive = async (filePath, userId) => {
//   try {
//     const userFolderId = await findOrCreateUserFolder(userId); // Get user folder ID

//     const fileMetadata = {
//       name: filePath.split("/").pop(),
//       parents: [userFolderId], // Place in user's folder
//     };

//     const media = {
//       mimeType: mime.lookup(filePath) || "application/octet-stream",
//       body: fs.createReadStream(filePath),
//     };

//     const response = await drive.files.create({
//       resource: fileMetadata,
//       media: media,
//       fields: "id",
//     });

//     console.log(
//       `File uploaded to ${userId}'s folder. File ID: ${response.data.id}`
//     );
//     return "OK";
//   } catch (error) {
//     console.error("Error uploading file:", error.message);
//     return error;
//   }
// };

// export const uploadFolderToDrive = async (localFolderPath, userId) => {
//   const userFolderId = await findOrCreateUserFolder(userId);
//   const folderName = path.basename(localFolderPath);
//   const newFolderId = await createFolder(folderName, userFolderId);

//   const items = fs.readdirSync(localFolderPath);

//   for (const item of items) {
//     const itemPath = path.join(localFolderPath, item);

//     if (fs.statSync(itemPath).isDirectory()) {
//       await uploadFolder(itemPath, userId);
//     } else {
//       await uploadFileFromBase64(itemPath, userId);
//     }
//   }
// };
