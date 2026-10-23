/*
 * iot_runtime.c — simulated sensors and devices for iotc-generated programs.
 *
 * Usage: ./program temperature=32 door=OPEN motion=ON
 * Every device starts OFF; evaluate_rules() runs once; the final device
 * states are printed.
 */
#include "iot_runtime.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_DEVICES 64

static int    g_argc;
static char **g_argv;
static bool   g_on[MAX_DEVICES];
static double g_level[MAX_DEVICES];

/* Returns the text after "name=" in the command-line arguments, or NULL. */
static const char *lookup(const char *name)
{
    size_t n = strlen(name);
    for (int i = 1; i < g_argc; i++)
        if (strncmp(g_argv[i], name, n) == 0 && g_argv[i][n] == '=')
            return g_argv[i] + n + 1;
    return NULL;
}

double read_number(const char *sensor)
{
    const char *v = lookup(sensor);
    if (!v) {
        fprintf(stderr, "warning: no value for sensor '%s', using 0\n", sensor);
        return 0.0;
    }
    return strtod(v, NULL);
}

state_t read_state(const char *sensor)
{
    static const struct { const char *name; state_t value; } names[] = {
        {"ON", STATE_ON}, {"OFF", STATE_OFF}, {"OPEN", STATE_OPEN},
        {"CLOSED", STATE_CLOSED}, {"TRUE", STATE_TRUE}, {"FALSE", STATE_FALSE},
    };
    const char *v = lookup(sensor);
    if (!v) {
        fprintf(stderr, "warning: no value for sensor '%s', using UNKNOWN\n", sensor);
        return STATE_UNKNOWN;
    }
    char buf[16];
    size_t i = 0;
    for (; v[i] && i < sizeof buf - 1; i++) buf[i] = (char)toupper((unsigned char)v[i]);
    buf[i] = '\0';
    for (size_t k = 0; k < sizeof names / sizeof names[0]; k++)
        if (strcmp(buf, names[k].name) == 0) return names[k].value;
    fprintf(stderr, "warning: unknown state '%s' for sensor '%s'\n", v, sensor);
    return STATE_UNKNOWN;
}

static int valid(int d) { return d >= 0 && d < iot_device_count && d < MAX_DEVICES; }

void turn_on(int d)
{
    if (!valid(d)) return;
    g_on[d] = true;
    if (g_level[d] == 0) g_level[d] = 100;
    printf("  turn_on(%s)\n", iot_device_names[d]);
}

void turn_off(int d)
{
    if (!valid(d)) return;
    g_on[d] = false;
    g_level[d] = 0;
    printf("  turn_off(%s)\n", iot_device_names[d]);
}

void toggle(int d)
{
    if (!valid(d)) return;
    g_on[d] = !g_on[d];
    g_level[d] = g_on[d] ? 100 : 0;
    printf("  toggle(%s)\n", iot_device_names[d]);
}

void set_level(int d, double level)
{
    if (!valid(d)) return;
    g_level[d] = level;
    g_on[d] = level > 0;
    printf("  set_level(%s, %g)\n", iot_device_names[d], level);
}

int main(int argc, char **argv)
{
    g_argc = argc;
    g_argv = argv;

    printf("Actions:\n");
    evaluate_rules();

    printf("Device states:\n");
    for (int d = 0; d < iot_device_count && d < MAX_DEVICES; d++) {
        if (g_on[d] && g_level[d] != 100)
            printf("  %-12s ON (level %g)\n", iot_device_names[d], g_level[d]);
        else
            printf("  %-12s %s\n", iot_device_names[d], g_on[d] ? "ON" : "OFF");
    }
    return 0;
}
