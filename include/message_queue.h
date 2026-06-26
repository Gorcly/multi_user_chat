#ifndef MESSAGE_QUEUE_H
#define MESSAGE_QUEUE_H

#include "protocol.h"

#include <stddef.h>
#include <stdbool.h>

typedef struct MessageQueue {
    Packet *items;
    size_t capacity;
    size_t head;
    size_t tail;
    size_t size;
} MessageQueue;

int message_queue_init(MessageQueue *queue, size_t capacity);
void message_queue_destroy(MessageQueue *queue);
int message_queue_enqueue(MessageQueue *queue, const Packet *packet);
int message_queue_dequeue(MessageQueue *queue, Packet *packet);
bool message_queue_is_empty(const MessageQueue *queue);

#endif
