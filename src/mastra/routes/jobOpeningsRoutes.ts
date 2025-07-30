import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
    res.send("Job Openings");
});

export default router;