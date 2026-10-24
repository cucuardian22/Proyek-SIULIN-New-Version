/**
 * Titik masuk web app. Seluruh antarmuka adalah satu halaman (client/Index);
 * perpindahan halaman diatur di browser oleh Core.js.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('client/Index')
    .evaluate()
    .setTitle(Config.APP_NAME + ' - Sistem Ujian Online')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Sisipkan isi file HTML lain: <?!= include('client/Style') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
