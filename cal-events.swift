#!/usr/bin/env swift
// cal-events.swift — reads Apple Calendar (EventKit) and outputs JSON
// No OAuth. Reads the local CalDAV cache synced from Google Calendar.
// Usage: swift cal-events.swift [days=7]

import EventKit
import Foundation

let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var output: [[String: Any]] = []

func isoString(_ date: Date) -> String {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime]
    return fmt.string(from: date)
}

store.requestFullAccessToEvents { granted, error in
    guard granted else {
        let result: [String: Any] = ["error": "Calendar access denied", "granted": false]
        if let json = try? JSONSerialization.data(withJSONObject: result),
           let str = String(data: json, encoding: .utf8) {
            print(str)
        }
        sema.signal()
        return
    }

    let days = Int(CommandLine.arguments.dropFirst().first ?? "7") ?? 7
    let start = Date()
    let end = Calendar.current.date(byAdding: .day, value: days, to: start)!

    let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: pred).sorted { $0.startDate < $1.startDate }

    for ev in events {
        var item: [String: Any] = [
            "title": ev.title ?? "Untitled",
            "start": isoString(ev.startDate),
            "end": isoString(ev.endDate),
            "calendar": ev.calendar?.title ?? "",
            "allDay": ev.isAllDay,
            "location": ev.location ?? "",
            "notes": ev.notes ?? ""
        ]
        output.append(item)
    }

    let result: [String: Any] = [
        "events": output,
        "count": output.count,
        "fetched": isoString(Date()),
        "days": days
    ]

    if let json = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted),
       let str = String(data: json, encoding: .utf8) {
        print(str)
    }
    sema.signal()
}

sema.wait()
