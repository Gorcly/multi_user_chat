#include "message_queue.h"

#include <stdlib.h>
#include <string.h>

int message_queue_init(MessageQueue *queue, size_t capacity) {
    if (queue == NULL || capacity == 0) {
        return -1;
    }
    memset(queue, 0, sizeof(*queue));
    queue->items = (Packet *)calloc(capacity, sizeof(Packet));
    if (queue->items == NULL) {
        return -1;
    }
    queue->capacity = capacity;
    return 0;
}

void message_queue_destroy(MessageQueue *queue) {
    if (queue == NULL) {
        return;
    }
    free(queue->items);
    memset(queue, 0, sizeof(*queue));
}

int message_queue_enqueue(MessageQueue *queue, const Packet *packet) {
    if (queue == NULL || packet == NULL || queue->items == NULL ||
        queue->size == queue->capacity) {
        return -1;
    }
    queue->items[queue->tail] = *packet;
    queue->tail = (queue->tail + 1) % queue->capacity;
    queue->size++;
    return 0;
}

int message_queue_dequeue(MessageQueue *queue, Packet *packet) {
    if (queue == NULL || packet == NULL || queue->items == NULL ||
        queue->size == 0) {
        return -1;
    }
    *packet = queue->items[queue->head];
    queue->head = (queue->head + 1) % queue->capacity;
    queue->size--;
    return 0;
}

bool message_queue_is_empty(const MessageQueue *queue) {
    return queue == NULL || queue->size == 0;
}
