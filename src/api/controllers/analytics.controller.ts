import { Request, Response } from "express";
import { OK } from "../../core/success.response.js";
import { ObjectId } from "../../utils/index.js";
import AnalyticsModel from "../models/analytics.model.js";

interface CreateEventRequest extends Request {
  body: {
    userId: string;
    event: string;
    payload?: any;
    deviceInfo?: Record<string, any>;
    browserInfo?: Record<string, any>;
    localeInfo?: Record<string, any>;
    webInfo?: Record<string, any>;
  };
}

export const createEvent = async (req: CreateEventRequest, res: Response) => {
  const {
    userId,
    event,
    payload,
    deviceInfo,
    browserInfo,
    localeInfo,
    webInfo,
  } = req.body;
  const newEvent = new AnalyticsModel({
    event: event,
    userId: ObjectId(userId),
    payload: payload,
    deviceInfo: deviceInfo,
    browserInfo: browserInfo,
    localeInfo: localeInfo,
    webInfo: webInfo,
  });
  await newEvent.save();
  new OK({
    message: "Event created successfully",
    metadata: {},
  }).send(res);
};

export const getEvents = async (_req: any, res: any) => {
  new OK({
    message: "No events to return yet",
    metadata: { events: [] },
  }).send(res);
};
