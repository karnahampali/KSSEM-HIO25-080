// middleware/errorHandler.js
const globalErrorHandler = (err, req, res, next) => {
  console.error("Unhandle Error:", err.stack || err.message);
  
  const message = err.message || "Internal Server Error";
  const statusCode = err.status || 500;
  
  // Handle JSON parsing errors specifically
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: `Invalid JSON: ${err.message}` });
  }
  
  // Do not leak stack traces to the client in production
  const response = { message };
  if (process.env.NODE_ENV !== 'production') {
     response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = { globalErrorHandler };