import cloudinary from "cloudinary";
import axios from "axios";

export const parseFlattenedQuery = (query) => {
  const result = {};

  for (const key in query) {
    if (key.includes("[") && key.includes("]")) {
      // Handle nested parameters like 'filter[page]'
      const [parent, child] = key.split("[").map((k) => k.replace("]", ""));
      if (!result[parent]) {
        result[parent] = {};
      }
      result[parent][child] = query[key];
    } else {
      // Handle regular parameters
      result[key] = query[key];
    }
  }

  return result;
};

export const uploadFileFromBase64 = async ({ base64, style = null }) => {
  try {
    if (!base64) {
      return "";
    }
    const timestamp = Math.round(new Date().getTime() / 1000);
    const cloud_name = process.env.CLOUDINARY_CLOUD_NAME ?? "";
    const api_key = process.env.CLOUDINARY_API_KEY ?? "";
    const api_secret = process.env.CLOUDINARY_API_SECRET ?? "";
    const signature = await cloudinary.utils.api_sign_request(
      {
        timestamp: timestamp,
      },
      api_secret
    );

    const dataForm = new FormData();
    dataForm.append("file", base64);
    dataForm.append("api_key", api_key);
    dataForm.append("cloud_name", cloud_name);
    dataForm.append("signature", signature);
    dataForm.append("timestamp", timestamp);
    const url = `https://api.cloudinary.com/v1_1/${cloud_name}/auto/upload`;
    const { data } = await axios.post(url, dataForm);
    if (style) {
      return `https://res.cloudinary.com/${cloud_name}/image/upload/${style}/${data.public_id}.png`;
    }
    console.log("fileUrl: ", data.url);
    return data.url;
  } catch (err) {
    console.error("uploadFileFromBase64: ", err?.message);
    return base64;
  }
};

export const uploadFile = async ({ file }) => {
  try {
    console.log("file: ", file);
    if (!file) {
      return "";
    }
    const timestamp = Math.round(new Date().getTime() / 1000);
    const cloud_name = process.env.CLOUDINARY_CLOUD_NAME ?? "";
    const api_key = process.env.CLOUDINARY_API_KEY ?? "";
    const api_secret = process.env.CLOUDINARY_API_SECRET ?? "";
    const signature = await cloudinary.utils.api_sign_request(
      {
        timestamp: timestamp,
      },
      api_secret
    );

    const dataForm = new FormData();
    dataForm.append("file", file);
    dataForm.append("api_key", api_key);
    dataForm.append("cloud_name", cloud_name);
    dataForm.append("signature", signature);
    dataForm.append("timestamp", timestamp);
    const url = `https://api.cloudinary.com/v1_1/${cloud_name}/raw/upload`;
    try {
      const { data } = await axios.post(url, dataForm);
    } catch (err) {
      console.log("cloudinary err: ", err.message);
    }
    console.log("fileUrl: ", data.url);
    return data.url;
  } catch (err) {
    console.error("uploadFile: ", err?.message);
  }
};

export const randomAvatar = () => {
  try {
    const randomNum = Math.floor(Math.random() * 70);
    const avatar = `https://i.pravatar.cc/300?img=${randomNum}`;
    return avatar;
  } catch (err) {
    console.log(err);
  }
};

export const getImgUnsplash = async ({ searchValue, page }) => {
  try {
    const ACCESS_KEY = process.env.UNSPLASH_API_KEY || "";
    if (!ACCESS_KEY) {
      return "";
    }
    const url = `https://api.unsplash.com/search/photos?page=${page}&query=${searchValue.trim()}&client_id=${ACCESS_KEY}`;
    const { data } = await axios.get(url);
    const results = data.results;
    const imgUrls = results.map(({ urls }) => {
      return urls.regular;
    });
    return imgUrls;
  } catch (err) {
    console.log(err);
  }
};

export const forgotPWMailForm = (to, decodedCode, url) => {
  return (
    `<!DOCTYPE html>
  <html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
  
  <head>
    <title></title>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0"><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
    <style>
      * {
        box-sizing: border-box;
      }
  
      body {
        margin: 0;
        padding: 0;
      }
  
      a[x-apple-data-detectors] {
        color: inherit !important;
        text-decoration: inherit !important;
      }
  
      #MessageViewBody a {
        color: inherit;
        text-decoration: none;
      }
  
      p {
        line-height: inherit
      }
  
      .desktop_hide,
      .desktop_hide table {
        mso-hide: all;
        display: none;
        max-height: 0px;
        overflow: hidden;
      }
  
      .image_block img+div {
        display: none;
      }
  
      @media (max-width:700px) {
        .desktop_hide table.icons-inner {
          display: inline-block !important;
        }
  
        .icons-inner {
          text-align: center;
        }
  
        .icons-inner td {
          margin: 0 auto;
        }
  
        .social_block.desktop_hide .social-table {
          display: inline-block !important;
        }
  
        .row-content {
          width: 100% !important;
        }
  
        .stack .column {
          width: 100%;
          display: block;
        }
  
        .mobile_hide {
          max-width: 0;
          min-height: 0;
          max-height: 0;
          font-size: 0;
          display: none;
          overflow: hidden;
        }
  
        .desktop_hide,
        .desktop_hide table {
          max-height: none !important;
          display: table !important;
        }
  
        .reverse {
          width: 100%;
          display: table;
        }
  
        .reverse .column.last {
          display: table-header-group !important;
        }
  
        .row-1 td.column.last .border {
          border: 0;
          padding: 0;
        }
      }
    </style>
  </head>
  
  <body style="text-size-adjust: none; background-color: #f9f9f9; margin: 0; padding: 0;">
    <table class="nl-container" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #f9f9f9;">
      <tbody>
        <tr>
          <td>
            <table class="row row-1" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
              <tbody>
                <tr>
                  <td>
                    <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000; background-color: #cbdbef; width: 680px; margin: 0 auto;" width="680">
                      <tbody>
                        <tr class="reverse">
                          <td class="column column-1 last" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; text-align: left; font-weight: 400; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                            <div class="border">
                              <table class="html_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                <tr>
                                  <td class="pad">
                                    <div style="font-family:Arial, 'Helvetica Neue', Helvetica, sans-serif;text-align:center;" align="center"><div class="our-class" style="height:80px; background-color: #5c77a8">
                                    0</div></div>
                                  </td>
                                </tr>
                              </table>
                              <div class="spacer_block block-2" style="height:40px;line-height:40px;font-size:1px;">&#8202;</div>
                              <table class="text_block block-3" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                <tr>
                                  <td class="pad" style="padding-bottom:25px;padding-left:20px;padding-right:20px;">
                                    <div style="font-family: Georgia, 'Times New Roman', serif">
                                      <div class style="font-size: 12px; font-family: Georgia, Times, 'Times New Roman', serif; mso-line-height-alt: 14.399999999999999px; color: #2f2f2f; line-height: 1.2;">
                                        <p style="margin: 0; font-size: 12px; text-align: center; mso-line-height-alt: 14.399999999999999px;"><strong><span style="font-size:28px;">Verify Account</span></strong></p>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              </table>
                              <table class="text_block block-4" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                <tr>
                                  <td class="pad" style="padding-bottom:10px;padding-left:30px;padding-right:30px;padding-top:10px;">
                                    <div style="font-family: sans-serif">
                                      <div class style="font-size: 14px; font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; mso-line-height-alt: 21px; color: #2f2f2f; line-height: 1.5;">
                                        <p style="margin: 0; font-size: 16px; text-align: left; mso-line-height-alt: 24px;"><span style="font-size:16px;">Hi ${to},</span></p>
                                        <p style="margin: 0; font-size: 16px; text-align: left; mso-line-height-alt: 24px;">This is an account verification to idicate that you are owner of this account</p>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              </table>
                              <table class="paragraph_block block-5" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                <tr>
                                  <td class="pad" style="padding-bottom:10px;padding-left:30px;padding-right:10px;padding-top:10px;">
                                    <div style="color:#101112;direction:ltr;font-family:Arial, 'Helvetica Neue', Helvetica, sans-serif;font-size:16px;font-weight:400;letter-spacing:0px;line-height:120%;text-align:left;mso-line-height-alt:19.2px;">
                                      <p style="margin: 0;">This is your code used to verify: ${decodedCode}</p>
                                    </div>
                                  </td>
                                </tr>
                              </table>
                              ` +
    (url
      ? `<table class="paragraph_block block-6" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                          <tr>
                                                            <td class="pad">
                                                              <div style="color:#101112;direction:ltr;font-family:Arial, 'Helvetica Neue', Helvetica, sans-serif;font-size:16px;font-weight:400;letter-spacing:0px;line-height:120%;text-align:left;mso-line-height-alt:19.2px;">
                                                                <p style="margin: 0;">&nbsp; &nbsp; Or you can click into this link to verify immediately:</p>
                                                              </div>
                                                            </td>
                                                          </tr>
                                                        </table>
                                                        <table class="paragraph_block block-7" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                          <tr>
                                                            <td class="pad" style="padding-bottom:10px;padding-left:30px;padding-right:10px;padding-top:10px;">
                                                              <div style="color:#101112;direction:ltr;font-family:Arial, 'Helvetica Neue', Helvetica, sans-serif;font-size:16px;font-weight:400;letter-spacing:0px;line-height:120%;text-align:left;mso-line-height-alt:19.2px;">
                                                                <p style="margin: 0;">${url}</p>
                                                              </div>
                                                            </td>
                                                          </tr>
                                                        </table>`
      : "") +
    `
                              <table class="paragraph_block block-8" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                <tr>
                                  <td class="pad">
                                    <div style="color:#101112;direction:ltr;font-family:Arial, 'Helvetica Neue', Helvetica, sans-serif;font-size:16px;font-weight:400;letter-spacing:0px;line-height:120%;text-align:left;mso-line-height-alt:19.2px;">&nbsp;</div>
                                  </td>
                                </tr>
                              </table>
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="row row-2" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
              <tbody>
                <tr>
                  <td>
                    <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000; background-color: #5d77a9; width: 680px; margin: 0 auto;" width="680">
                      <tbody>
                        <tr>
                          <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; text-align: left; font-weight: 400; padding-bottom: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                            <div class="spacer_block block-1" style="height:20px;line-height:20px;font-size:1px;">&#8202;</div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="row row-3" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
              <tbody>
                <tr>
                  <td>
                    <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000; background-color: #5d77a9; width: 680px; margin: 0 auto;" width="680">
                      <tbody>
                        <tr>
                          <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; text-align: left; font-weight: 400; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                            <table class="social_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                              <tr>
                                <td class="pad">
                                  <div class="alignment" align="center">
                                    <table class="social-table" width="108px" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; display: inline-block;">
                                      <tr>
                                        <td style="padding:0 2px 0 2px;"><a href="https://www.facebook.com/profile.php?id=100034442176742" target="_blank"><img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-circle-white/facebook@2x.png" width="32" height="32" alt="Facebook" title="Facebook" style="height: auto; display: block; border: 0;"></a></td>
                                        <td style="padding:0 2px 0 2px;"><a href="https://www.instagram.com/duckviruss/" target="_blank"><img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-circle-white/instagram@2x.png" width="32" height="32" alt="Instagram" title="Instagram" style="height: auto; display: block; border: 0;"></a></td>
                                        <td style="padding:0 2px 0 2px;"><a href="https://www.youtube.com/channel/UCz6eR936LKpomovPDWWTwJw" target="_blank"><img src="https://app-rsrc.getbee.io/public/resources/social-networks-icon-sets/t-circle-white/youtube@2x.png" width="32" height="32" alt="YouTube" title="YouTube" style="height: auto; display: block; border: 0;"></a></td>
                                      </tr>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="row row-4" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
              <tbody>
                <tr>
                  <td>
                    <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000; background-color: #5d77a9; width: 680px; margin: 0 auto;" width="680">
                      <tbody>
                        <tr>
                          <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; text-align: left; font-weight: 400; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                            <table class="text_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                              <tr>
                                <td class="pad">
                                  <div style="font-family: sans-serif">
                                    <div class style="font-size: 12px; font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; mso-line-height-alt: 14.399999999999999px; color: #cfceca; line-height: 1.2;">
                                      <p style="margin: 0; font-size: 14px; text-align: center; mso-line-height-alt: 16.8px;"><span style="font-size:12px;">© ADucky 2023</span></p>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="row row-5" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
              <tbody>
                <tr>
                  <td>
                    <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000; width: 680px; margin: 0 auto;" width="680">
                      <tbody>
                        <tr>
                          <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; text-align: left; font-weight: 400; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                            <table class="icons_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                              <tr>
                                <td class="pad" style="vertical-align: middle; color: #9d9d9d; font-family: inherit; font-size: 15px; padding-bottom: 5px; padding-top: 5px; text-align: center;">
                                  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tr>
                                      <td class="alignment" style="vertical-align: middle; text-align: center;"><!--[if vml]><table align="left" cellpadding="0" cellspacing="0" role="presentation" style="display:inline-block;padding-left:0px;padding-right:0px;mso-table-lspace: 0pt;mso-table-rspace: 0pt;"><![endif]-->
                                        <!--[if !vml]><!-->
                                        <table class="icons-inner" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; display: inline-block; margin-right: -4px; padding-left: 0px; padding-right: 0px;" cellpadding="0" cellspacing="0" role="presentation"><!--<![endif]-->
                                          <tr>
                                            <td style="vertical-align: middle; text-align: center; padding-top: 5px; padding-bottom: 5px; padding-left: 5px; padding-right: 6px;"><a href="https://www.designedwithbee.com/" target="_blank" style="text-decoration: none;"><img class="icon" alt="Designed with BEE" src="https://d15k2d11r6t6rl.cloudfront.net/public/users/Integrators/BeeProAgency/53601_510656/Signature/bee.png" height="32" width="34" align="center" style="height: auto; display: block; margin: 0 auto; border: 0;"></a></td>
                                            <td style="font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; font-size: 15px; color: #9d9d9d; vertical-align: middle; letter-spacing: undefined; text-align: center;"><a href="https://www.designedwithbee.com/" target="_blank" style="color: #9d9d9d; text-decoration: none;">Designed with BEE</a></td>
                                          </tr>
                                        </table>
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table><!-- End -->
  </body>
  
  </html>`
  );
};

export const emailFormWithHtml = (html) => {
  return `<!DOCTYPE html>

<html
  lang="en"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:v="urn:schemas-microsoft-com:vml"
>
  <head>
    <title></title>
    <meta content="text/html; charset=utf-8" http-equiv="Content-Type" />
    <meta content="width=device-width, initial-scale=1.0" name="viewport" />
    <!--[if mso
      ]><xml
        ><o:OfficeDocumentSettings
          ><o:PixelsPerInch>96</o:PixelsPerInch
          ><o:AllowPNG /></o:OfficeDocumentSettings></xml
    ><![endif]-->
    <!--[if !mso]><!-->
    <!--<![endif]-->
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
      }

      a[x-apple-data-detectors] {
        color: inherit !important;
        text-decoration: inherit !important;
      }

      #MessageViewBody a {
        color: inherit;
        text-decoration: none;
      }

      p {
        line-height: inherit;
      }

      .desktop_hide,
      .desktop_hide table {
        mso-hide: all;
        display: none;
        max-height: 0px;
        overflow: hidden;
      }

      .image_block img + div {
        display: none;
      }

      sup,
      sub {
        font-size: 75%;
        line-height: 0;
      }

      @media (max-width: 520px) {
        .desktop_hide table.icons-inner {
          display: inline-block !important;
        }

        .icons-inner {
          text-align: center;
        }

        .icons-inner td {
          margin: 0 auto;
        }

        .mobile_hide {
          display: none;
        }

        .row-content {
          width: 100% !important;
        }

        .stack .column {
          width: 100%;
          display: block;
        }

        .mobile_hide {
          min-height: 0;
          max-height: 0;
          max-width: 0;
          overflow: hidden;
          font-size: 0px;
        }

        .desktop_hide,
        .desktop_hide table {
          display: table !important;
          max-height: none !important;
        }
      }
    </style>
    <!--[if mso
      ]><style>
        sup,
        sub {
          font-size: 100% !important;
        }
        sup {
          mso-text-raise: 10%;
        }
        sub {
          mso-text-raise: -10%;
        }
      </style>
    <![endif]-->
  </head>
  <body
    class="body"
    style="
      background-color: #ffffff;
      margin: 0;
      padding: 0;
      -webkit-text-size-adjust: none;
      text-size-adjust: none;
    "
  >
    <table
      border="0"
      cellpadding="0"
      cellspacing="0"
      class="nl-container"
      role="presentation"
      style="
        mso-table-lspace: 0pt;
        mso-table-rspace: 0pt;
        background-color: #ffffff;
      "
      width="100%"
    >
      <tbody>
        <tr>
          <td>
            <table
              align="center"
              border="0"
              cellpadding="0"
              cellspacing="0"
              class="row row-1"
              role="presentation"
              style="mso-table-lspace: 0pt; mso-table-rspace: 0pt"
              width="100%"
            >
              <tbody>
                <tr>
                  <td>
                    <table
                      align="center"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      class="row-content stack"
                      role="presentation"
                      style="
                        mso-table-lspace: 0pt;
                        mso-table-rspace: 0pt;
                        border-radius: 0;
                        color: #000000;
                        width: 500px;
                        margin: 0 auto;
                      "
                      width="500"
                    >
                      <tbody>
                        <tr>
                          <td
                            class="column column-1"
                            style="
                              mso-table-lspace: 0pt;
                              mso-table-rspace: 0pt;
                              font-weight: 400;
                              text-align: left;
                              padding-bottom: 5px;
                              padding-top: 5px;
                              vertical-align: top;
                            "
                            width="100%"
                          >
                            <table
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              class="html_block block-1"
                              role="presentation"
                              style="
                                mso-table-lspace: 0pt;
                                mso-table-rspace: 0pt;
                              "
                              width="100%"
                            >
                              <tr>
                                <td class="pad">
                                  <div
                                    align="center"
                                    style="
                                      font-family: Arial, 'Helvetica Neue',
                                        Helvetica, sans-serif;
                                      text-align: center;
                                    "
                                  >
                                  ${html}
                                  </div>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
            <table
              align="center"
              border="0"
              cellpadding="0"
              cellspacing="0"
              class="row row-2"
              role="presentation"
              style="
                mso-table-lspace: 0pt;
                mso-table-rspace: 0pt;
                background-color: #ffffff;
              "
              width="100%"
            >
              <tbody>
                <tr>
                  <td>
                    <table
                      align="center"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      class="row-content stack"
                      role="presentation"
                      style="
                        mso-table-lspace: 0pt;
                        mso-table-rspace: 0pt;
                        background-color: #ffffff;
                        color: #000000;
                        width: 500px;
                        margin: 0 auto;
                      "
                      width="500"
                    >
                      <tbody>
                        <tr>
                          <td
                            class="column column-1"
                            style="
                              mso-table-lspace: 0pt;
                              mso-table-rspace: 0pt;
                              font-weight: 400;
                              text-align: left;
                              padding-bottom: 5px;
                              padding-top: 5px;
                              vertical-align: top;
                            "
                            width="100%"
                          >
                            <table
                              border="0"
                              cellpadding="0"
                              cellspacing="0"
                              class="icons_block block-1"
                              role="presentation"
                              style="
                                mso-table-lspace: 0pt;
                                mso-table-rspace: 0pt;
                                text-align: center;
                                line-height: 0;
                              "
                              width="100%"
                            >
                              <tr>
                                <td
                                  class="pad"
                                  style="
                                    vertical-align: middle;
                                    color: #1e0e4b;
                                    font-family: 'Inter', sans-serif;
                                    font-size: 15px;
                                    padding-bottom: 5px;
                                    padding-top: 5px;
                                    text-align: center;
                                  "
                                >
                                  <!--[if vml]><table align="center" cellpadding="0" cellspacing="0" role="presentation" style="display:inline-block;padding-left:0px;padding-right:0px;mso-table-lspace: 0pt;mso-table-rspace: 0pt;"><![endif]-->
                                  <!--[if !vml]><!-->
                                  <table
                                    cellpadding="0"
                                    cellspacing="0"
                                    class="icons-inner"
                                    role="presentation"
                                    style="
                                      mso-table-lspace: 0pt;
                                      mso-table-rspace: 0pt;
                                      display: inline-block;
                                      padding-left: 0px;
                                      padding-right: 0px;
                                    "
                                  >
                                    <!--<![endif]-->
                                    <tr>
                                      <td
                                        style="
                                          vertical-align: middle;
                                          text-align: center;
                                          padding-top: 5px;
                                          padding-bottom: 5px;
                                          padding-left: 5px;
                                          padding-right: 6px;
                                        "
                                      >
                                        <a
                                          href="http://designedwithbeefree.com/"
                                          style="text-decoration: none"
                                          target="_blank"
                                          ><img
                                            align="center"
                                            alt="Beefree Logo"
                                            class="icon"
                                            height="auto"
                                            src="images/Beefree-logo.png"
                                            style="
                                              display: block;
                                              height: auto;
                                              margin: 0 auto;
                                              border: 0;
                                            "
                                            width="34"
                                        /></a>
                                      </td>
                                      <td
                                        style="
                                          font-family: 'Inter', sans-serif;
                                          font-size: 15px;
                                          font-weight: undefined;
                                          color: #1e0e4b;
                                          vertical-align: middle;
                                          letter-spacing: undefined;
                                          text-align: center;
                                          line-height: normal;
                                        "
                                      >
                                        <a
                                          href="http://designedwithbeefree.com/"
                                          style="
                                            color: #1e0e4b;
                                            text-decoration: none;
                                          "
                                          target="_blank"
                                          >Designed with Beefree</a
                                        >
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
    <!-- End -->
  </body>
</html>
`;
};

export const validateEmailForm = (code, expireTime) => {
  return `
  <!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Email Verification</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f4;">
    <table cellpadding="0" cellspacing="0" width="100%" style="background-color:#f4f4f4; padding: 20px 0;">
      <tr>
        <td align="center">
          <table cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; padding: 30px; font-family: Arial, sans-serif; box-shadow: 0 0 10px rgba(0,0,0,0.1);">
            <tr>
              <td align="center" style="padding-bottom: 20px;">
                <h2 style="color: #333;">Verify Your Email Address</h2>
              </td>
            </tr>
            <tr>
              <td style="color: #555; font-size: 16px; line-height: 1.5; padding-bottom: 20px;">
                Thanks for signing up! Please use the following code to verify your email address and complete your account setup:
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom: 20px;">
                <div style="display: inline-block; background-color: #f0f0f0; color: #333; font-size: 24px; font-weight: bold; padding: 12px 24px; border-radius: 6px; letter-spacing: 4px;">
                  <!-- Replace this dynamically -->
                  ${code}
                </div>
              </td>
            </tr>
            <tr>
              <td style="color: #777; font-size: 14px; padding-top: 20px;">
                This code will expire in ${expireTime} minutes. If you did not request this, please ignore this email.
              </td>
            </tr>
            <tr>
              <td style="padding-top: 30px; font-size: 12px; color: #aaa;">
                &copy; 2025 Breads. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>

  `;
};
