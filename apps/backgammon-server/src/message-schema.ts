import { z } from "zod";
import type { ClientMessage } from "./types.js";

const gameId = z.string().min(1).max(80);
const address = z.string().min(1).max(80);
const request = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const command = {
  command_id: z.string().uuid().optional(),
  expected_revision: z.number().int().min(0).optional(),
};

const ClientMessageSchema = z.discriminatedUnion("type", [
  request({ type: z.literal("create_game"), wager_amount: z.literal(0), match_length: z.number().int().min(1).max(25).optional(), time_control: z.number().int().min(10).max(3_600).optional() }),
  request({ type: z.literal("join_cash_game"), quote_id: z.string().uuid() }),
  request({ type: z.literal("join_game"), game_id: gameId }),
  request({ type: z.literal("rejoin_game"), game_id: gameId }),
  request({ type: z.literal("join_queue"), wager_amount: z.literal(0), match_length: z.number().int().min(1).max(25).optional() }),
  request({ type: z.literal("leave_queue") }),
  request({ type: z.literal("move"), game_id: gameId, from: z.number().int().min(0).max(25), to: z.number().int().min(0).max(25), ...command }),
  request({ type: z.literal("end_turn"), game_id: gameId, ...command }),
  request({ type: z.literal("roll_dice"), game_id: gameId, ...command }),
  request({ type: z.literal("undo_move"), game_id: gameId, ...command }),
  request({ type: z.literal("resign"), game_id: gameId, resign_type: z.enum(["normal", "gammon", "backgammon"]).optional(), ...command }),
  request({ type: z.literal("accept_resign"), game_id: gameId, ...command }),
  request({ type: z.literal("reject_resign"), game_id: gameId, ...command }),
  request({ type: z.literal("offer_double"), game_id: gameId, ...command }),
  request({ type: z.literal("accept_double"), game_id: gameId, ...command }),
  request({ type: z.literal("reject_double"), game_id: gameId, ...command }),
  request({ type: z.literal("request_cash_review"), game_id: gameId, command_id: z.string().uuid(), expected_revision: z.number().int().min(0) }),
  request({ type: z.literal("set_profile"), display_name: z.string().min(1).max(50) }),
  request({ type: z.literal("get_friends") }),
  request({ type: z.literal("send_friend_request"), to_address: address }),
  request({ type: z.literal("accept_friend_request"), from_address: address }),
  request({ type: z.literal("reject_friend_request"), from_address: address }),
  request({ type: z.literal("remove_friend"), address }),
  request({ type: z.literal("get_activity") }),
  request({
    type: z.literal("challenge_friend"),
    to_address: address,
    config: z.object({
      version: z.literal("free-challenge-v1"),
      mode: z.literal("free"),
      match_length: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]),
      doubling_cube: z.boolean(),
      time_control: z.number().int().min(10).max(3_600),
    }).strict(),
  }),
  request({ type: z.literal("accept_challenge"), challenge_id: z.string().min(1).max(80) }),
  request({ type: z.literal("decline_challenge"), challenge_id: z.string().min(1).max(80) }),
  request({ type: z.literal("set_username"), username: z.string().min(1).max(30) }),
  request({ type: z.literal("search_players"), query: z.string().min(1).max(80) }),
  request({ type: z.literal("block_user"), target_address: address, request_id: z.string().uuid() }),
  request({ type: z.literal("unblock_user"), target_address: address }),
  request({
    type: z.literal("report_user"),
    target_address: address,
    category: z.enum(["cheating", "harassment", "inappropriate_name", "other"]),
    description: z.string().max(500).optional(),
    request_id: z.string().uuid(),
  }),
  request({ type: z.literal("reaction"), game_id: gameId, emoji: z.string().min(1).max(16) }),
]);

export function parseClientMessage(value: unknown): ClientMessage | null {
  const result = ClientMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}
