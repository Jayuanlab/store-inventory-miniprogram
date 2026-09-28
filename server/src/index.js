const { createServer } = require("./application");
const { transaction } = require("./repository");
transaction(() => {});
const port = Number(process.env.PORT || 3100);
const server = createServer();
server.listen(port, () =>
  console.log(`Store ERP API ready at http://127.0.0.1:${port}`),
);
